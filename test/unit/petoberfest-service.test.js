// test/unit/petoberfest-service.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

const { GET, POST } = cds.test('serve', '--project', '.', '--in-memory');

let db;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests, PetSubmissions, Users } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Petoberfests).entries({
    ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'Petoberfest 2026', status: 'ACTIVE',
  }));
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 'sap-1', email: 'a@b.c' }));
  await db.run(INSERT.into(PetSubmissions).entries([
    { ID: 's-appr', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Rex', uploaderName: 'Tom',
      moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z' },
    { ID: 's-pend', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Milo', uploaderName: 'Tom',
      moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T01:00:00Z' },
  ]));
});

test('slideshow returns only APPROVED entries', async () => {
  const { data } = await GET(`/petoberfest-api/slideshow(slug='petoberfest-2026')`);
  const rows = data.value ?? data;
  expect(rows.length).toBe(1);
  expect(rows[0].petName).toBe('Rex');
});

test('slideshow is anonymous-accessible (no auth header)', async () => {
  const res = await GET(`/petoberfest-api/slideshow(slug='petoberfest-2026')`);
  expect(res.status).toBe(200);
});
