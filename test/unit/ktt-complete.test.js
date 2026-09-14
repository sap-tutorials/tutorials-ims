// test/unit/ktt-complete.test.js
// Unit test for KttService.completeLesson — writes a KTT_LESSON TaskRecord (idempotent).
// Also covers syncProgress — merges local JSON progress with HANA state.
// Bootstrap: same ESM + cds.test pattern used across test/unit/ served-mode tests.

import cds from '@sap/cds';
import { expect, test, beforeAll, afterAll } from 'vitest';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const { POST } = cds.test('serve', '--project', '.', '--in-memory');

let authed;
beforeAll(async () => {
  // Force KTT_ENABLED ON for all tests in this file so the success-path
  // assertions are not blocked by the flag gate introduced in Task 6.
  __setFlagForTest('KTT_ENABLED', true);

  const { Users, KttLessons } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: 'alice', sapId: 'alice', legacyId: 1 });
  // The KttLessons catalog is now seeded from db/data/…-KttLessons.csv, so clear
  // it first to avoid an @assert.unique(legacyId) collision on this controlled
  // fixture (seed legacyId 90001 slug 'unit-1-platform-lesson-1').
  await DELETE.from(KttLessons);
  await INSERT.into(KttLessons).entries({ ID: cds.utils.uuid(), legacyId: 90001, slug: 'core-1' });
  authed = { auth: { username: 'alice', password: 'alice' } };
});

afterAll(() => {
  __resetFlagsForTest();
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

test('syncProgress merges local JSON with HANA TaskRecords and returns merged totals', async () => {
  // alice already has a KTT_LESSON TaskRecord for legacyId 90001 (slug 'core-1')
  // from the completeLesson test above. syncProgress should reflect it in mastered
  // without double-inserting.
  const localJson = JSON.stringify({ xp: 50, streak: 2, mastered: ['core-1'] });
  const r = await POST('/ktt/syncProgress', { localJson }, authed);
  expect(r.data.mastered).toContain('core-1');
  expect(r.data.xp).toBe(50);
  expect(r.data.streak).toBe(2);

  // Confirm no double-insert occurred — still exactly one KTT_LESSON for 90001.
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TaskRecords).where({ taskLegacyId: 90001, taskType: 'KTT_LESSON' });
  expect(rows.length).toBe(1);
});
