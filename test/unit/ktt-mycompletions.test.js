// test/unit/ktt-mycompletions.test.js
// Verifies that completed KTT_LESSON TaskRecords surface in getMyCompletedTutorials
// with kind:'ktt' — the function powering the /me MyCompletions endpoint.
//
// Uses direct-function style (mirrors user-progress.test.js): cds.deploy to
// in-memory SQLite, seed data, call the exported function. No HTTP round-trip
// needed — the function is pure data logic, HTTP-endpoint testing is covered by
// the served-mode smoke suite.

import path from 'node:path';
import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';
import { getMyCompletedTutorials } from '../../srv/lib/user-progress.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

const USER_UUID = 'ktt-test-user-uuid-001';
const USER_ID   = 'bbbbbbbb-0000-0000-0000-000000000001';

async function seed() {
  const { Users, KttLessons, TaskRecords } = cds.entities('com.sap.developers.ims');

  await DELETE.from(TaskRecords);
  await DELETE.from(KttLessons);
  await DELETE.from(Users);

  await INSERT.into(Users).entries({
    ID: USER_ID,
    uuid: USER_UUID,
    sapId: USER_UUID,   // resolveDbUserId looks up WHERE sapId = user.id (issue #343)
    legacyId: 9999
  });

  await INSERT.into(KttLessons).entries({
    ID: cds.utils.uuid(),
    legacyId: 90001,
    slug: 'core-1',
    unitId: 'core',
    title: 'Meet the Platform',
    order: 1
  });

  await INSERT.into(TaskRecords).entries({
    ID: cds.utils.uuid(),
    user_ID: USER_ID,
    taskLegacyId: 90001,
    taskType: 'KTT_LESSON',
    status: 'COMPLETED',
    completionDate: '2026-09-01T10:00:00Z',
    modifiedAt: '2026-09-01T10:00:00Z',
    titleSnapshot: 'Meet the Platform',
    attemptNumber: 1
  });
}

describe('getMyCompletedTutorials — KTT lessons', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    await seed();
  });

  it('surfaces completed KTT_LESSON records as kind:"ktt" entries', async () => {
    const result = await getMyCompletedTutorials({ id: USER_UUID });
    expect(result.length).toBeGreaterThan(0);
    const kttEntry = result.find(e => e.kind === 'ktt');
    expect(kttEntry).toBeDefined();
    expect(kttEntry).toMatchObject({
      kind: 'ktt',
      slug: 'core-1',
      title: 'Meet the Platform'
    });
    expect(kttEntry.completionDate).toBeTruthy();
    expect(typeof kttEntry.attemptNumber).toBe('number');
  });

  it('does NOT surface KTT_LESSON records as kind:"tutorial", "puzzle", or "petoberfest"', async () => {
    const result = await getMyCompletedTutorials({ id: USER_UUID });
    const wrongKind = result.find(e => e.slug === 'core-1' && e.kind !== 'ktt');
    expect(wrongKind).toBeUndefined();
  });

  it('returns empty array for user with no completions', async () => {
    const result = await getMyCompletedTutorials({ id: 'nobody' });
    expect(result).toEqual([]);
  });
});
