import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates, AdvocateLinks } = cds.entities('com.sap.developers.ims');
  const exists = await db.run(SELECT.from(Advocates).columns('slug').where({ slug: '__test__single-slug-amer' }));
  if (!exists.length) {
    await db.run(INSERT.into(Advocates).entries({
      ID: 'ADC00601-0000-0000-0000-000000000001',
      slug: '__test__single-slug-amer',
      firstName: 'FixtureSingle', lastName: 'Amer',
      title: 'Advocate', region: 'AMERICAS', isActive: true,
      bio: '**Hello** world',
    }));
    await db.run(INSERT.into(Advocates).entries({
      ID: 'ADC00601-0000-0000-0000-000000000002',
      slug: '__test__single-inactive',
      firstName: 'FixtureSingle', lastName: 'Inactive',
      region: 'EMEA', isActive: false,
    }));
  }
});

afterAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(Advocates).where`firstName like 'FixtureSingle%'`);
});

describe('GET /api/advocates/:slug', () => {
  it('returns 200 + the advocate shape for an active slug', async () => {
    const res = await project.get('/api/advocates/__test__single-slug-amer');
    expect(res.status).toBe(200);
    expect(res.data.slug).toBe('__test__single-slug-amer');
    expect(res.data.firstName).toBe('FixtureSingle');
    expect(res.data.bio).toBe('**Hello** world');
    expect(res.data).toHaveProperty('topics');
    expect(res.data).toHaveProperty('links');
    expect(res.data).not.toHaveProperty('advocates'); // single, not list
  });

  it('responds with ETag and Cache-Control', async () => {
    const res = await project.get('/api/advocates/__test__single-slug-amer');
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
    expect(res.headers['cache-control']).toMatch(/stale-while-revalidate=600/);
  });

  it('returns 304 on conditional GET', async () => {
    const first = await project.get('/api/advocates/__test__single-slug-amer');
    const etag = first.headers.etag;
    const second = await project.get('/api/advocates/__test__single-slug-amer', {
      headers: { 'if-none-match': etag },
      validateStatus: () => true,
    });
    expect(second.status).toBe(304);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await project.get('/api/advocates/__does-not-exist__', { validateStatus: () => true });
    expect(res.status).toBe(404);
  });

  it('returns 404 for inactive advocate', async () => {
    const res = await project.get('/api/advocates/__test__single-inactive', { validateStatus: () => true });
    expect(res.status).toBe(404);
  });
});
