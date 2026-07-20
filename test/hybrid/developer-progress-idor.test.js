// test/hybrid/developer-progress-idor.test.js
//
// Regression test for issue #1231 — IDOR in the three legacy progress
// functions on DeveloperService. Before the fix, the target user was resolved
// from a client-supplied `userLegacyId`, so any authenticated caller could read
// any other user's TaskRecords / mission-completion counts by enumerating the
// small sequential legacyId. The fix resolves the acting user from the verified
// JWT (resolveUserSapId) and ignores `userLegacyId` for identity.
//
// In-memory SQLite. We invoke the functions programmatically via
// srv.tx({ user }, tx => tx.send(...)) so we can (a) pin the caller identity and
// (b) pass the array param as a real JS array (avoids OData URL array-encoding).
// Under this path resolveUserSapId() falls back to user.id, so we seed Users
// rows whose sapId equals the caller's user.id.
//
// Run: npm run test:hybrid -- test/hybrid/developer-progress-idor.test.js
//   (does NOT require HANA / cds bind — boots in-memory)

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

// userA = the CALLER; userB = the VICTIM.
const USER_A = { sapId: 'idor-caller', ID: 'd1230001-0000-0000-0000-0000000000a1', legacyId: 71001 };
const USER_B = { sapId: 'idor-victim', ID: 'd1230001-0000-0000-0000-0000000000b2', legacyId: 71002 };

const MISSION_1 = 61001;
const MISSION_2 = 61002;
const TASK_TUT = 62001;

// Caller principal: user.id → resolveUserSapId fallback → sapId 'idor-caller'.
// Carries Tutorial.API so the #1232 TaskRecords READ passes the @restrict gate
// (that scope is the actual external-partner threat actor for #1232); also has
// authenticated-user for the #1231 function calls.
const callerUser = { id: USER_A.sapId, roles: { 'authenticated-user': 1, 'Tutorial.API': 1 } };

let dev;

async function asCaller(event, data) {
  return dev.tx({ user: callerUser }, (tx) => tx.send(event, data));
}

beforeAll(async () => {
  dev = await cds.connect.to('DeveloperService');
  const { Users, TaskRecords, Missions } = cds.entities(NS);

  await DELETE.from(TaskRecords).where({ user_ID: { in: [USER_A.ID, USER_B.ID] } });
  await DELETE.from(Users).where({ ID: { in: [USER_A.ID, USER_B.ID] } });

  await INSERT.into(Users).entries([
    { ID: USER_A.ID, uuid: USER_A.sapId, sapId: USER_A.sapId, legacyId: USER_A.legacyId },
    { ID: USER_B.ID, uuid: USER_B.sapId, sapId: USER_B.sapId, legacyId: USER_B.legacyId },
  ]);

  // Ensure two missions exist so the percent denominator is stable.
  for (const legacyId of [MISSION_1, MISSION_2]) {
    const existing = await SELECT.one.from(Missions).where({ legacyId });
    if (!existing) {
      await INSERT.into(Missions).entries({
        ID: cds.utils.uuid(),
        slug: `idor-mission-${legacyId}`,
        title: `IDOR mission ${legacyId}`,
        legacyId,
        status: 'ACTIVE',
      });
    }
  }

  // userA: 1 completed mission + 1 tutorial record.
  // userB: 2 completed missions + a secret tutorial note (must never leak to A).
  await INSERT.into(TaskRecords).entries([
    { ID: cds.utils.uuid(), user_ID: USER_A.ID, taskLegacyId: MISSION_1, taskType: 'MISSION', status: 'COMPLETED', legacyId: 72001 },
    { ID: cds.utils.uuid(), user_ID: USER_A.ID, taskLegacyId: TASK_TUT, taskType: 'TUTORIAL', status: 'COMPLETED', progressNote: 'USER_A_NOTE', legacyId: 72002 },
    { ID: cds.utils.uuid(), user_ID: USER_B.ID, taskLegacyId: MISSION_1, taskType: 'MISSION', status: 'COMPLETED', legacyId: 72003 },
    { ID: cds.utils.uuid(), user_ID: USER_B.ID, taskLegacyId: MISSION_2, taskType: 'MISSION', status: 'COMPLETED', legacyId: 72004 },
    { ID: cds.utils.uuid(), user_ID: USER_B.ID, taskLegacyId: TASK_TUT, taskType: 'TUTORIAL', status: 'COMPLETED', progressNote: 'USER_B_SECRET_NOTE', legacyId: 72005 },
  ]);
});

describe('#1231 — DeveloperService progress functions are self-scoped (IDOR closed)', () => {
  it('findTaskProgressByUserAndTasksIds ignores a victim userLegacyId and never returns victim rows', async () => {
    // userA calls with userB's legacyId + a task both users completed.
    const rows = await asCaller('findTaskProgressByUserAndTasksIds', {
      userLegacyId: USER_B.legacyId,
      taskLegacyIds: [TASK_TUT],
    });
    const leaked = rows.some((r) => r.user_ID === USER_B.ID || r.progressNote === 'USER_B_SECRET_NOTE');
    expect(leaked).toBe(false);
    // Every returned row belongs to the caller (userA).
    expect(rows.every((r) => r.user_ID === USER_A.ID)).toBe(true);
    // Positive proof the caller sees their OWN row for that task.
    expect(rows.some((r) => r.progressNote === 'USER_A_NOTE')).toBe(true);
  });

  it('countCompletedMissionsTotal returns the caller count regardless of userLegacyId passed', async () => {
    // userA has 1 completed mission; userB has 2. Must reflect the CALLER (1).
    const viaVictimId = await asCaller('countCompletedMissionsTotal', { userLegacyId: USER_B.legacyId });
    expect(viaVictimId).toBe(1);
    const viaOwnId = await asCaller('countCompletedMissionsTotal', { userLegacyId: USER_A.legacyId });
    expect(viaOwnId).toBe(1);
  });

  it('countCompletedMissionsPercent reflects the caller, not the victim userLegacyId', async () => {
    const viaVictimId = await asCaller('countCompletedMissionsPercent', { userLegacyId: USER_B.legacyId });
    const viaOwnId = await asCaller('countCompletedMissionsPercent', { userLegacyId: USER_A.legacyId });
    // Passing userA's own id vs userB's id must yield the SAME result (caller's),
    // proving userLegacyId does not steer identity. userA completed 1 of 2 → 0.5.
    expect(viaVictimId).toBe(viaOwnId);
    expect(viaOwnId).toBe(0.5);
  });
});

describe('#1232 — TaskRecords READ is row-scoped to the caller', () => {
  // The TaskRecords projection is @restrict grant:'*' to:'Tutorial.API' with NO
  // where-clause and (before this fix) no before('READ') handler — so any
  // Tutorial.API holder could page every user's progress rows. The fix scopes
  // reads to the caller's own user_ID via a before('READ') handler (mirrors
  // LearningPreferences). callerUser resolves to userA (sapId 'idor-caller').

  it('returns only the caller (userA) rows — never userB rows or PII', async () => {
    const rows = await dev.tx({ user: callerUser }, (tx) => tx.read('TaskRecords'));
    expect(rows.length).toBeGreaterThan(0); // userA has records
    expect(rows.every((r) => r.user_ID === USER_A.ID)).toBe(true);
    expect(rows.some((r) => r.user_ID === USER_B.ID)).toBe(false);
    expect(rows.some((r) => r.progressNote === 'USER_B_SECRET_NOTE')).toBe(false);
    // Positive proof the caller sees their own data.
    expect(rows.some((r) => r.progressNote === 'USER_A_NOTE')).toBe(true);
  });

  it('a caller-supplied filter cannot widen past the caller rows', async () => {
    // Explicitly filter for userB's rows — the before-READ where must AND-conjoin
    // so this still yields only userA's rows (empty intersection here). Read the
    // SERVICE entity by name (not the db-layer handle) so the handler fires.
    const rows = await dev.tx({ user: callerUser }, (tx) =>
      tx.read('TaskRecords').where({ user_ID: USER_B.ID }),
    );
    expect(rows.some((r) => r.user_ID === USER_B.ID)).toBe(false);
    expect(rows.every((r) => r.user_ID === USER_A.ID)).toBe(true);
  });

  it('a caller with no Users row gets an empty result set', async () => {
    const strangerUser = { id: 'no-such-sapid-1232', roles: { 'authenticated-user': 1, 'Tutorial.API': 1 } };
    const rows = await dev.tx({ user: strangerUser }, (tx) => tx.read('TaskRecords'));
    expect(rows).toEqual([]);
  });
});

describe('#1232 (adjacent) — LearningPreferences READ does not leak on the no-Users-row path', () => {
  // Same fix pattern surfaced a latent bug in the sibling LearningPreferences
  // handler: assigning req.results = [] in a before('READ') does NOT reliably
  // short-circuit in CAP 10, so a caller with no Users row (e.g. a freshly
  // authenticated user before lazy auto-provisioning) would read EVERY user's
  // preferences. LearningPreferences is readable by any authenticated-user, so
  // the window is broad. Hardened to a query-level impossible predicate.
  beforeAll(async () => {
    const { UserLearningPreferences } = cds.entities(NS);
    await DELETE.from(UserLearningPreferences).where({ user_ID: USER_B.ID });
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: USER_B.ID, deployment: 'cloud', role: 'developer', cloud: 'btp',
    });
  });

  it('a caller with no Users row sees no other users preferences', async () => {
    const strangerUser = { id: 'no-such-sapid-1232b', roles: { 'authenticated-user': 1 } };
    const rows = await dev.tx({ user: strangerUser }, (tx) => tx.read('LearningPreferences'));
    expect(rows.some((r) => r.user_ID === USER_B.ID)).toBe(false);
    expect(rows).toEqual([]);
  });
});
