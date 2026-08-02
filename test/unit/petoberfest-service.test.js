// test/unit/petoberfest-service.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { resolveOrCreatePetUser } from '../../srv/petoberfest-service.js';

cds.test('serve', '--project', '.', '--in-memory');

let db, svc;

beforeAll(async () => {
  db = await cds.connect.to('db');
  svc = await cds.connect.to('PetoberfestService');
  const { Petoberfests, PetSubmissions, Users } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Petoberfests).entries({
    ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'Petoberfest 2026', status: 'ACTIVE',
  });
  // u1 = the "caller" user whose sapId matches the FAKE_CALLER token
  await INSERT.into(Users).entries({ ID: 'u1', sapId: 'sap-1', email: 'a@b.c' });
  // u2 = a different user whose submissions must NOT appear in myUploads for u1
  await INSERT.into(Users).entries({ ID: 'u2', sapId: 'sap-2', email: 'x@y.z' });
  await INSERT.into(PetSubmissions).entries([
    { ID: 's-appr', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Rex', uploaderName: 'Tom',
      moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z' },
    { ID: 's-pend', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Milo', uploaderName: 'Tom',
      moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T01:00:00Z' },
    { ID: 's-other', petoberfest_ID: 'p1', user_ID: 'u2', petName: 'Buddy', uploaderName: 'Other',
      moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T02:00:00Z' },
  ]);
});

// ── slideshow ─────────────────────────────────────────────────────────────

test('slideshow returns only APPROVED entries', async () => {
  const rows = await svc.tx({}, tx => tx.send('slideshow', { slug: 'petoberfest-2026' }));
  expect(rows.length).toBe(2); // Rex (u1, APPROVED) + Buddy (u2, APPROVED)
  expect(rows.every(r => r.petName)).toBe(true); // shape check
});

test('slideshow excludes PENDING entries', async () => {
  const rows = await svc.tx({}, tx => tx.send('slideshow', { slug: 'petoberfest-2026' }));
  expect(rows.find(r => r.petName === 'Milo')).toBeUndefined();
});

test('slideshow is anonymous-accessible (no auth header)', async () => {
  const rows = await svc.tx({}, tx => tx.send('slideshow', { slug: 'petoberfest-2026' }));
  expect(Array.isArray(rows)).toBe(true);
});

// ── myUploads ─────────────────────────────────────────────────────────────

// sapId 'sap-1' resolves to Users row u1 (seeded above)
const CALLER = { id: 'sap-1', attr: {} };

test('myUploads returns only the caller\'s rows (PENDING + APPROVED), not other users', async () => {
  const rows = await svc.tx({ user: new cds.User(CALLER) }, tx =>
    tx.send('myUploads', { slug: 'petoberfest-2026' })
  );
  // Both of u1's submissions (Rex APPROVED + Milo PENDING) must appear
  expect(rows.length).toBe(2);
  // Must NOT include Buddy (u2)
  expect(rows.find(r => r.petName === 'Buddy')).toBeUndefined();
  // Shape check: {id, petName, moderation, uploadedAt}
  const rex = rows.find(r => r.petName === 'Rex');
  expect(rex).toBeDefined();
  expect(rex).toHaveProperty('id');
  expect(rex).toHaveProperty('moderation', 'APPROVED');
  expect(rex).toHaveProperty('uploadedAt');
  const milo = rows.find(r => r.petName === 'Milo');
  expect(milo).toBeDefined();
  expect(milo).toHaveProperty('moderation', 'PENDING');
});

// ── resolveOrCreatePetUser ────────────────────────────────────────────────

test('resolveOrCreatePetUser creates a new Users row on first call', async () => {
  const newUser = { id: 'sap-new', attr: { email: 'new@test.com', given_name: 'Ada', family_name: 'Lovelace' } };
  const result = await resolveOrCreatePetUser(db, newUser);
  expect(result).toBeDefined();
  expect(result.sapId).toBe('sap-new');

  const { Users } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(Users).where({ sapId: 'sap-new' });
  expect(row).toBeDefined();
  expect(row.email).toBe('new@test.com');
  expect(row.firstName).toBe('Ada');
  expect(row.lastName).toBe('Lovelace');
});

test('resolveOrCreatePetUser returns existing row on second call (no duplicate)', async () => {
  const existingUser = { id: 'sap-new', attr: {} };
  const result = await resolveOrCreatePetUser(db, existingUser);
  expect(result).toBeDefined();

  const { Users } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Users).where({ sapId: 'sap-new' });
  expect(rows.length).toBe(1);
});
