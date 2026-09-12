import { test, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;

beforeAll(async () => {
  model = await cds.load(['db', 'srv']);
});

test('TaskRecords accepts KTT_LESSON and KttLessons entity exists', async () => {
  const csn = cds.linked(model);
  const tr = csn.definitions['com.sap.developers.ims.TaskRecords'];
  const enumVals = Object.keys(tr.elements.taskType.enum);
  expect(enumVals).toContain('KTT_LESSON');
  expect(csn.definitions['com.sap.developers.ims.KttLessons']).toBeDefined();
  expect(csn.definitions['com.sap.developers.ims.KttLessons'].elements.legacyId).toBeDefined();
});
