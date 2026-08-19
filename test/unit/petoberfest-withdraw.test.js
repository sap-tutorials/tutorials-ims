// test/unit/petoberfest-withdraw.test.js
import { expect, test, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import sharp from 'sharp';
import { uploadPetSubmission } from '../../srv/lib/petoberfest-upload.js';

cds.test('serve', '--project', '.', '--in-memory');

let db, svc;

// sapId 'sap-1' resolves to Users row u1; the withdraw handler owner-scopes on it.
const CALLER = { id: 'sap-1', attr: { email: 'a@b.c', given_name: 'Tom', family_name: 'J' } };

beforeAll(async () => {
  db = await cds.connect.to('db');
  svc = await cds.connect.to('PetoberfestService');
  const { Petoberfests, Users } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Petoberfests).entries({
    ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'Petoberfest 2026', status: 'ACTIVE',
  });
  await INSERT.into(Users).entries({ ID: 'u1', sapId: 'sap-1', email: 'a@b.c' });
  await INSERT.into(Users).entries({ ID: 'u2', sapId: 'sap-2', email: 'x@y.z' });
});

beforeEach(async () => {
  const { PetSubmissions, TaskRecords } = cds.entities('com.sap.developers.ims');
  await DELETE.from(PetSubmissions);
  await DELETE.from(TaskRecords);
});

function seedSubmission(id, userID, extra = {}) {
  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  return INSERT.into(PetSubmissions).entries({
    ID: id, petoberfest_ID: 'p1', user_ID: userID, petName: id, uploaderName: 'x',
    moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z', ...extra,
  });
}

function seedCompletion(userID) {
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  return INSERT.into(TaskRecords).entries({
    ID: cds.utils.uuid(), user_ID: userID, taskLegacyId: 9001, taskType: 'PETOBERFEST',
    status: 'COMPLETED', progress: 100, completionDate: '2026-08-01T00:00:00Z',
  });
}

const withdraw = (data) => svc.tx({ user: new cds.User(CALLER) }, tx => tx.send('withdraw', data));

test('owner can withdraw their own submission — the row is hard-deleted', async () => {
  await seedSubmission('s1', 'u1');
  await seedCompletion('u1');

  const res = await withdraw({ slug: 'petoberfest-2026', id: 's1' });
  expect(res.withdrawn).toBe(true);

  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(PetSubmissions).where({ ID: 's1' });
  expect(row).toBeUndefined();
});

test('withdrawing the last remaining submission supersedes the PETOBERFEST completion', async () => {
  await seedSubmission('s1', 'u1');
  await seedCompletion('u1');

  const res = await withdraw({ slug: 'petoberfest-2026', id: 's1' });
  expect(res.creditRevoked).toBe(true);

  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const active = await SELECT.from(TaskRecords).where({ user_ID: 'u1', taskType: 'PETOBERFEST', status: { '!=': 'SUPERSEDED' } });
  expect(active.length).toBe(0);
});

test('withdrawing one of two submissions keeps the completion (credit not revoked)', async () => {
  await seedSubmission('s1', 'u1');
  await seedSubmission('s2', 'u1');
  await seedCompletion('u1');

  const res = await withdraw({ slug: 'petoberfest-2026', id: 's1' });
  expect(res.creditRevoked).toBe(false);

  const { PetSubmissions, TaskRecords } = cds.entities('com.sap.developers.ims');
  const remaining = await SELECT.from(PetSubmissions).where({ user_ID: 'u1' });
  expect(remaining.length).toBe(1);
  expect(remaining[0].ID).toBe('s2');
  const completed = await SELECT.from(TaskRecords).where({ user_ID: 'u1', taskType: 'PETOBERFEST', status: 'COMPLETED' });
  expect(completed.length).toBe(1);
});

test('a user cannot withdraw another user\'s submission', async () => {
  await seedSubmission('s-other', 'u2');

  await expect(withdraw({ slug: 'petoberfest-2026', id: 's-other' })).rejects.toThrow();

  const { PetSubmissions } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(PetSubmissions).where({ ID: 's-other' });
  expect(row).toBeDefined();
});

test('re-upload after a full withdraw re-awards the completion', async () => {
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const first = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: CALLER, buffer: png, mimeType: 'image/png', petName: 'Rex' });
  expect(first.awarded).toBe(true);

  const res = await withdraw({ slug: 'petoberfest-2026', id: first.id });
  expect(res.withdrawn).toBe(true);
  expect(res.creditRevoked).toBe(true);

  const png2 = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
  const second = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: CALLER, buffer: png2, mimeType: 'image/png', petName: 'Milo' });
  expect(second.awarded).toBe(true);
});
