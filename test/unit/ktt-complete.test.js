// test/unit/ktt-complete.test.js
// Unit test for KttService.completeLesson — writes a KTT_LESSON TaskRecord (idempotent).
// Bootstrap: same ESM + cds.test pattern used across test/unit/ served-mode tests.

import cds from '@sap/cds';
import { expect, test, beforeAll } from 'vitest';

const { POST } = cds.test('serve', '--project', '.', '--in-memory');

let authed;
beforeAll(async () => {
  const { Users } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: 'alice', sapId: 'alice', legacyId: 1 });
  authed = { auth: { username: 'alice', password: 'alice' } };
});

test('completeLesson writes one KTT_LESSON TaskRecord and is idempotent', async () => {
  const body = { lessonSlug: 'core-1', legacyId: 90001, title: 'Meet the Platform' };
  const r1 = await POST('/ktt/completeLesson', body, authed);
  expect(r1.data.ok).toBe(true);
  expect(r1.data.alreadyDone).toBe(false);
  const r2 = await POST('/ktt/completeLesson', body, authed);
  expect(r2.data.alreadyDone).toBe(true);
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TaskRecords).where({ taskLegacyId: 90001, taskType: 'KTT_LESSON' });
  expect(rows.length).toBe(1);
});
