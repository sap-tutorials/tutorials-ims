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
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 's1' }));
  await db.run(INSERT.into(PetSubmissions).entries({ ID: 's1', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Rex', moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z' }));
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
