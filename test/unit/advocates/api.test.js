import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Advocates admin handlers', () => {
  afterAll(async () => {
    const db = await cds.connect.to('db');
    const { Advocates } = cds.entities('com.sap.developers.ims');
    // Clean up TEST rows so re-runs are isolated; preserve seeded fixtures.
    await db.run(DELETE.from(Advocates).where`firstName like '__TEST__%'`);
  });

  it('auto-derives slug from firstName/lastName on activate', async () => {
    // POST creates a draft. With @odata.draft.enabled, the handler must
    // produce a final slug by the time the row reaches active state.
    const res = await project.post('/admin/Advocates', {
      firstName: '__TEST__Andre',
      lastName:  'Muller',
      region:    'EMEA'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect([201, 200]).toContain(res.status);
    expect(res.data.slug).toBe('test-andre-muller');
  });

  it('appends -2 on slug collision', async () => {
    const a = await project.post('/admin/Advocates', {
      firstName: '__TEST__Casey',
      lastName:  'Smith',
      region:    'AMERICAS'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(a.data.slug).toBe('test-casey-smith');
    const b = await project.post('/admin/Advocates', {
      firstName: '__TEST__Casey',
      lastName:  'Smith',
      region:    'APJ'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(b.data.slug).toBe('test-casey-smith-2');
  });
});

describe('GET /api/advocates', () => {
  it('returns active rows sorted by lastName, includes topics, links, hasPhoto', async () => {
    const res = await project.get('/api/advocates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.advocates)).toBe(true);
    expect(res.data.advocates.length).toBeGreaterThan(0);

    // Default placeholders sort by lastName: APJ, Americas, EMEA, Jung, Roving
    const collator = new Intl.Collator('en', { sensitivity: 'base' });
    const lastNames = res.data.advocates.map((a) => a.lastName);
    const sorted = [...lastNames].sort((a, b) => collator.compare(a, b));
    expect(lastNames).toEqual(sorted);

    const sample = res.data.advocates[0];
    expect(sample).toHaveProperty('topics');
    expect(sample).toHaveProperty('links');
    expect(sample).toHaveProperty('hasPhoto');
    expect(typeof sample.hasPhoto).toBe('boolean');

    // ETag + Cache-Control
    expect(res.headers.etag || res.headers.ETag).toMatch(/^"[a-z0-9]+"$/);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
    expect(res.headers['cache-control']).toMatch(/stale-while-revalidate=600/);
  });

  it('returns 304 when If-None-Match matches the ETag', async () => {
    const first = await project.get('/api/advocates');
    const etag = first.headers.etag || first.headers.ETag;
    expect(etag).toBeTruthy();

    // axios (cds.test's HTTP client) by default treats 304 as an error;
    // catch and assert on the response.
    let status;
    try {
      const res = await project.get('/api/advocates', {
        headers: { 'If-None-Match': etag },
        // axios `validateStatus` lets us accept 304 as "ok"
        validateStatus: (s) => s === 200 || s === 304,
      });
      status = res.status;
    } catch (err) {
      status = err.response?.status;
    }
    expect(status).toBe(304);
  });

  it('omits inactive advocates', async () => {
    const db = await cds.connect.to('db');
    const { Advocates } = cds.entities('com.sap.developers.ims');
    const id = '11111111-aaaa-bbbb-cccc-222222222222';
    await db.run(INSERT.into(Advocates).entries({
      ID: id,
      slug: '__test__inactive-' + Date.now().toString(36),
      firstName: '__TEST__Hidden',
      lastName: 'Person',
      region: 'AMERICAS',
      isActive: false,
    }));
    const res = await project.get('/api/advocates');
    expect(res.data.advocates.find((a) => a.ID === id)).toBeUndefined();
    await db.run(DELETE.from(Advocates).where({ ID: id }));
  });
});
