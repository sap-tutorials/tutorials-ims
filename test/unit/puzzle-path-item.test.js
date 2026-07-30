// test/unit/puzzle-path-item.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

test('CompletionPathItems accepts taskType PUZZLE', async () => {
  const { CompletionPathItems } = cds.entities('com.sap.developers.ims');
  await INSERT.into(CompletionPathItems).entries({ ID: cds.utils.uuid(), taskType: 'PUZZLE', itemOrder: 1 });
  const row = await SELECT.one.from(CompletionPathItems).where({ taskType: 'PUZZLE' });
  expect(row).toBeTruthy();
});
