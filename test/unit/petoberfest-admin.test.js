// test/unit/petoberfest-admin.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin', roles: ['Admin', 'Tutorial.Author', 'authenticated-user'] };
const UNPRIV_USER = { id: 'unprivileged', roles: ['authenticated-user'] };

let db;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests, PetSubmissions, Users } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Petoberfests).entries({ ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'P26', status: 'ACTIVE' }));
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 's1', email: 'tom@example.com' }));
  await db.run(INSERT.into(PetSubmissions).entries({ ID: 's1', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Rex', moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z' }));
});

test('PetSubmissions projection exposes uploaderEmail flattened from the user association (#2597)', async () => {
  // uploaderName is often NULL (token lacked given_name/family_name), so the
  // admin UI shows the uploader's email as a fallback. Verify the projection
  // actually surfaces it from user.email — a scalar path expression, no LOB.
  const srv = await cds.connect.to('AdminService');
  const row = await srv.tx({ user: ADMIN_USER }, (tx) =>
    tx.run(SELECT.one.from('AdminService.PetSubmissions').columns('ID', 'uploaderEmail').where({ ID: 's1' })));
  expect(row).toBeDefined();
  expect(row.uploaderEmail).toBe('tom@example.com');
});

test('uploaderName falls back to the uploader email when the name is NULL', async () => {
  // s1 was seeded with no uploaderName (token lacked given_name/family_name).
  // The projection coalesce(uploaderName, user.email) must surface the email
  // so the Uploader column/field is never blank.
  const srv = await cds.connect.to('AdminService');
  const row = await srv.tx({ user: ADMIN_USER }, (tx) =>
    tx.run(SELECT.one.from('AdminService.PetSubmissions').columns('ID', 'uploaderName').where({ ID: 's1' })));
  expect(row.uploaderName).toBe('tom@example.com');
});

test('uploaderName keeps the real name when present (no fallback)', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'named', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Bella',
    uploaderName: 'Tom Jung', moderation: 'PENDING', mimeType: 'image/webp',
    uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  const row = await srv.tx({ user: ADMIN_USER }, (tx) =>
    tx.run(SELECT.one.from('AdminService.PetSubmissions').columns('ID', 'uploaderName').where({ ID: 'named' })));
  expect(row.uploaderName).toBe('Tom Jung');
});

test('approve sets moderation APPROVED', async () => {
  const srv = await cds.connect.to('AdminService');
  await srv.tx({ user: ADMIN_USER }, async (tx) => {
    await tx.send({ event: 'approve', entity: 'PetSubmissions', params: [{ ID: 's1' }] });
  });
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 's1' }));
  expect(row.moderation).toBe('APPROVED');
});

test('hide sets moderation HIDDEN', async () => {
  const srv = await cds.connect.to('AdminService');
  await srv.tx({ user: ADMIN_USER }, async (tx) => {
    await tx.send({ event: 'hide', entity: 'PetSubmissions', params: [{ ID: 's1' }] });
  });
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 's1' }));
  expect(row.moderation).toBe('HIDDEN');
});

test('authenticated-user without Admin is rejected (403) from approve', async () => {
  // AdminService is @requires:'Admin' at service level — CAP rejects non-Admin callers
  // before any action handler runs. Action-level @requires(['Tutorial.Author','Admin'])
  // in the CDS ANDs with the service gate; it does not lower the bar for non-Admin callers.
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: UNPRIV_USER }, (tx) =>
      tx.send({ event: 'approve', entity: 'PetSubmissions', params: [{ ID: 's1' }] })
    )
  ).rejects.toMatchObject({ code: 403 });
});

test('authenticated-user without Admin is rejected (403) from hide', async () => {
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: UNPRIV_USER }, (tx) =>
      tx.send({ event: 'hide', entity: 'PetSubmissions', params: [{ ID: 's1' }] })
    )
  ).rejects.toMatchObject({ code: 403 });
});

test('purge deletes a HIDDEN submission (row and blobs gone)', async () => {
  const { Petoberfests, PetSubmissions, Users } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-hidden', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'ToDelete',
    moderation: 'HIDDEN', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await srv.tx({ user: ADMIN_USER }, (tx) =>
    tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-hidden' }] }));
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 'del-hidden' }));
  expect(row).toBeUndefined();
});

test('purge rejects a PENDING submission (400)', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-pending', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Nope',
    moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-pending' }] }))
  ).rejects.toMatchObject({ code: 400 });
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 'del-pending' }));
  expect(row).toBeDefined();     // still there
});

test('purge rejects an APPROVED submission (400)', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-approved', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Live',
    moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-approved' }] }))
  ).rejects.toMatchObject({ code: 400 });
});

test('authenticated-user without Admin is rejected (403) from purge', async () => {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: 'del-unpriv', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Guard',
    moderation: 'HIDDEN', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z',
  }));
  const srv = await cds.connect.to('AdminService');
  await expect(
    srv.tx({ user: UNPRIV_USER }, (tx) =>
      tx.send({ event: 'purge', entity: 'PetSubmissions', params: [{ ID: 'del-unpriv' }] }))
  ).rejects.toMatchObject({ code: 403 });
});
