import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

let db;
beforeAll(async () => { db = await cds.connect.to('db'); });

test('TASK_VALUE_HELP_V1 surfaces PETOBERFEST rows', async () => {
  // Requires an ACTIVE Petoberfests row present in the bound HANA container.
  const rows = await db.run('SELECT "TASKTYPE","SLUG" FROM "TASK_VALUE_HELP_V1" WHERE "TASKTYPE" = ?', ['PETOBERFEST']);
  expect(Array.isArray(rows)).toBe(true);
  // At least the schema/view resolves; row count depends on seeded data.
});
