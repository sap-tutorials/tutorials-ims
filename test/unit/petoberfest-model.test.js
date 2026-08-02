// test/unit/petoberfest-model.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;
beforeAll(async () => { model = await cds.load(cds.env.folders.db + '/schema.cds'); });

test('Petoberfests entity exists with slug + intro', () => {
  const e = model.definitions['com.sap.developers.ims.Petoberfests'];
  expect(e).toBeDefined();
  expect(e.elements.slug).toBeDefined();
  expect(e.elements.intro).toBeDefined();
});

test('PetSubmissions has moderation + two media columns', () => {
  const e = model.definitions['com.sap.developers.ims.PetSubmissions'];
  expect(e).toBeDefined();
  expect(e.elements.moderation).toBeDefined();
  expect(e.elements.photoDisplay['@Core.MediaType']).toBeTruthy();
  expect(e.elements.photoThumb['@Core.MediaType']).toBeTruthy();
  expect(e.elements.petName).toBeDefined();
  expect(e.elements.uploaderName).toBeDefined();
});

test('PETOBERFEST is a valid TaskRecords.taskType enum value', () => {
  const tr = model.definitions['com.sap.developers.ims.TaskRecords'];
  expect(tr.elements.taskType.enum.PETOBERFEST).toBeDefined();
});
