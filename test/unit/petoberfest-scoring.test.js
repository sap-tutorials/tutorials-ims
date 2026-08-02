// Task 8 — PETOBERFEST task-type scoring integration.
//
// Asserts that getMyCompletedTutorials includes a PETOBERFEST completion
// with kind:'petoberfest' and the correct slug so devtoberfest-feed.js can
// award activity points.

import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { getMyCompletedTutorials } from '../../srv/lib/user-progress.js';

cds.test('serve', '--project', '.', '--in-memory');
let db;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests, TaskRecords, Users } = cds.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 's1' }));
  await db.run(INSERT.into(Petoberfests).entries({ ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'P26', status: 'ACTIVE' }));
  await db.run(INSERT.into(TaskRecords).entries({ ID: 't1', legacyId: 1, user_ID: 'u1', taskLegacyId: 9001, taskType: 'PETOBERFEST', status: 'COMPLETED', progress: 100 }));
});

test('getMyCompletedTutorials includes a PETOBERFEST completion with kind petoberfest', async () => {
  // Pass a user object whose id resolves to sapId 's1' → Users.ID 'u1'
  const rows = await getMyCompletedTutorials({ id: 's1' });
  const pet = rows.find((r) => r.slug === 'petoberfest-2026');
  expect(pet).toBeDefined();
  expect(pet.kind).toBe('petoberfest');
});
