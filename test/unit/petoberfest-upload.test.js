import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';
import sharp from 'sharp';
import { uploadPetSubmission } from '../../srv/lib/petoberfest-upload.js';

cds.test('serve', '--project', '.', '--in-memory');
let db, png;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Petoberfests).entries({
    ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'Petoberfest 2026', status: 'ACTIVE' }));
  png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r:1,g:2,b:3 } } }).png().toBuffer();
});

const fakeUser = { id: 'sap-42', attr: { email: 't@x.c', given_name: 'Tom', family_name: 'J' } };

test('first upload awards a COMPLETED PETOBERFEST TaskRecord', async () => {
  const r = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: fakeUser, buffer: png, mimeType: 'image/png', petName: 'Rex' });
  expect(r.awarded).toBe(true);
  expect(r.moderation).toBe('PENDING');
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const recs = await db.run(SELECT.from(TaskRecords).where({ taskType: 'PETOBERFEST', status: 'COMPLETED' }));
  expect(recs.length).toBe(1);
  expect(recs[0].taskLegacyId).toBe(9001);
});

test('second upload (different photo) adds a pet but does NOT re-award', async () => {
  const png2 = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r:9,g:9,b:9 } } }).png().toBuffer();
  const r = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: fakeUser, buffer: png2, mimeType: 'image/png', petName: 'Milo' });
  expect(r.awarded).toBe(false);
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const recs = await db.run(SELECT.from(TaskRecords).where({ taskType: 'PETOBERFEST', status: 'COMPLETED' }));
  expect(recs.length).toBe(1);
});

test('exact-duplicate re-upload is rejected as duplicate', async () => {
  const r = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: fakeUser, buffer: png, mimeType: 'image/png', petName: 'Rex again' });
  expect(r.duplicate).toBe(true);
});
