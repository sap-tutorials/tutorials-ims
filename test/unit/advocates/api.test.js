import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import { processUpload, _resetCache } from '../../../srv/lib/advocate-photo-store.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

// Seed the advocates these tests reference. CSVs were removed from
// db/data so prod deploys don't clobber admin edits — tests own their
// fixtures from here on.
beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates, AdvocateLinks } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.from(Advocates).columns('slug'));
  const slugs = new Set(existing.map((r) => r.slug));
  const rows = [];
  // NOTE: seed rows use 'Fixture*' firstNames, NOT '__TEST__*'. The slug
  // already carries the anti-shadow safety marker (no real advocate could
  // get '__test__advocate-link-*'). firstName MUST stay out of the
  // '__TEST__%' namespace because the afterAll cleanup below (line ~56)
  // deletes rows matching that pattern — seed rows would get wiped between
  // describe blocks and downstream tests would 404.
  if (!slugs.has('__test__advocate-link-amer-1')) {
    rows.push({
      ID: 'ADC00001-0000-0000-0000-000000000001',
      slug: '__test__advocate-link-amer-1',
      firstName: 'FixtureAmer', lastName: 'One',
      title: 'Unit test fixture',
      pronouns: '', location: 'Test, TS',
      region: 'AMERICAS', isActive: true,
      bio: 'Unit test fixture — safe to delete.',
    });
  }
  if (!slugs.has('__test__advocate-link-emea-1')) {
    rows.push({
      ID: 'ADC00001-0000-0000-0000-000000000002',
      slug: '__test__advocate-link-emea-1',
      firstName: 'FixtureEmea', lastName: 'One',
      title: 'Unit test fixture',
      region: 'EMEA', isActive: true,
    });
  }
  if (rows.length) {
    await db.run(INSERT.into(Advocates).entries(rows));
    await db.run(INSERT.into(AdvocateLinks).entries(rows.map((r, i) => ({
      ID: 'ADL00001-0000-0000-0000-00000000000' + (i + 1),
      advocate_ID: r.ID,
      kind: 'LinkedIn',
      url: 'https://www.linkedin.com/in/' + r.slug,
      label: 'LinkedIn',
      sortOrder: 100,
    }))));
  }
});

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

    // Active advocates are returned sorted by lastName (case-insensitive).
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

describe('GET /api/advocates/:slug/photo', () => {
  let processed;

  beforeAll(async () => {
    _resetCache();
    const buf = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    processed = await processUpload(buf, 'image/jpeg');

    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    const advocate = await db.run(
      SELECT.one.from(Advocates).where({ slug: '__test__advocate-link-amer-1' }),
    );
    // Idempotent — the photo-serve.test.js suite may have inserted one already.
    await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: advocate.ID }));
    await db.run(
      INSERT.into(AdvocatePhotos).entries({
        advocate_ID: advocate.ID,
        photo256: processed.photo256,
        photo64: processed.photo64,
        photoMimeType: 'image/webp',
        sizeBytes: processed.sizeBytes,
        sha256: processed.sha256,
        uploadedAt: new Date().toISOString(),
      }),
    );
    _resetCache();
  });

  it('returns 404 when the advocate has no photo row', async () => {
    let status;
    try {
      const res = await project.get('/api/advocates/__test__advocate-link-emea-1/photo', {
        validateStatus: (s) => s === 200 || s === 404,
        responseType: 'arraybuffer',
      });
      status = res.status;
    } catch (err) {
      status = err.response?.status;
    }
    expect(status).toBe(404);
  });

  it('returns 404 for an unknown slug', async () => {
    let status;
    try {
      const res = await project.get('/api/advocates/no-such-advocate/photo', {
        validateStatus: (s) => s === 200 || s === 404,
        responseType: 'arraybuffer',
      });
      status = res.status;
    } catch (err) {
      status = err.response?.status;
    }
    expect(status).toBe(404);
  });

  it('returns the WebP for a real photo with ETag and Cache-Control', async () => {
    const res = await project.get('/api/advocates/__test__advocate-link-amer-1/photo', {
      responseType: 'arraybuffer',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/webp/);
    expect(res.headers.etag).toBe('"' + processed.sha256 + '"');
    expect(res.headers['cache-control']).toMatch(/max-age=86400/);
    // Body matches the processed bytes.
    expect(Buffer.compare(Buffer.from(res.data), processed.photo256)).toBe(0);
  });

  it('returns ?size=thumb 64-px WebP', async () => {
    const res = await project.get('/api/advocates/__test__advocate-link-amer-1/photo?size=thumb', {
      responseType: 'arraybuffer',
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(Buffer.from(res.data), processed.photo64)).toBe(0);
  });

  it('returns 304 when If-None-Match matches the photo sha256', async () => {
    const first = await project.get('/api/advocates/__test__advocate-link-amer-1/photo', {
      responseType: 'arraybuffer',
    });
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    let status;
    try {
      const res = await project.get('/api/advocates/__test__advocate-link-amer-1/photo', {
        headers: { 'If-None-Match': etag },
        validateStatus: (s) => s === 200 || s === 304,
        responseType: 'arraybuffer',
      });
      status = res.status;
    } catch (err) {
      status = err.response?.status;
    }
    expect(status).toBe(304);
  });
});

describe('AdvocatePhotos upload handler', () => {
  it('processPhotoUpload mutates data.photo256 from raw JPEG to processed WebP', async () => {
    const { processPhotoUpload } = await import('../../../srv/handlers/advocate-handlers.js');
    const rawJpeg = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    const data = {
      photo256: rawJpeg,
      photoMimeType: 'image/jpeg',
    };
    await processPhotoUpload({ data, headers: {} });

    expect(data.photoMimeType).toBe('image/webp');
    expect(data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.sizeBytes).toBeGreaterThan(0);
    expect(data.uploadedAt).toBeTruthy();

    // photo256 + photo64 are Buffers of WebP bytes (RIFF magic).
    expect(Buffer.isBuffer(data.photo256)).toBe(true);
    expect(Buffer.isBuffer(data.photo64)).toBe(true);
    expect(data.photo256.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(data.photo256.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(data.photo64.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(data.photo64.length).toBeLessThan(data.photo256.length);
  });

  it('processPhotoUpload is a no-op when no photo256 was sent', async () => {
    const { processPhotoUpload } = await import('../../../srv/handlers/advocate-handlers.js');
    const data = { photoMimeType: 'image/webp', sortOrder: 5 };
    await processPhotoUpload({ data, headers: {} });
    // Nothing else got mutated — sha256 etc. weren't set.
    expect(data.sha256).toBeUndefined();
    expect(data.sizeBytes).toBeUndefined();
    expect(data.uploadedAt).toBeUndefined();
    // The original payload is untouched.
    expect(data.sortOrder).toBe(5);
  });

  it('processPhotoUpload accepts a Readable stream as photo256', async () => {
    const { processPhotoUpload } = await import('../../../srv/handlers/advocate-handlers.js');
    const { Readable } = await import('node:stream');
    const rawJpeg = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    const stream = Readable.from([rawJpeg]);
    const data = { photo256: stream, photoMimeType: 'image/jpeg' };
    await processPhotoUpload({ data, headers: {} });
    expect(Buffer.isBuffer(data.photo256)).toBe(true);
    expect(data.photo256.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('processPhotoUpload falls back to req.headers content-type when photoMimeType missing', async () => {
    const { processPhotoUpload } = await import('../../../srv/handlers/advocate-handlers.js');
    const rawJpeg = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    const data = { photo256: rawJpeg };
    await processPhotoUpload({
      data,
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(data.photoMimeType).toBe('image/webp');
  });
});
