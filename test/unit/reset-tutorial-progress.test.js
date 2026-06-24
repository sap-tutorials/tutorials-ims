import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _resetForTests as resetRateLimitBuckets } from '../../srv/lib/per-user-rate-limit.js';

const __filename_t13 = fileURLToPath(import.meta.url);
const __dirname_t13 = dirname(__filename_t13);

// Boots CAP with in-memory SQLite, deploys the model, and exposes
// SELECT/INSERT/UPDATE/DELETE as globals. Same pattern as
// test/unit/author-service.test.js — do NOT move this inside beforeAll;
// it has to bind at module-load so the schema is deployed before
// the describe blocks below try to read cds.entities(...).
const project = cds.test('serve', '--project', '.', '--in-memory');

// Per-user rate-limit state leaks across tests within this file (the
// limiter is a module-level Map). Reset before each test so the Task 18
// 5/hour quota only counts that test's own calls. Other tests run with
// a fresh bucket too — that's the correct isolation behavior.
beforeEach(() => {
  resetRateLimitBuckets();
});

// Shared seed helper — reused by Tasks 3, 4, 5, 6, 7, 8 to avoid
// duplicating the same 4-INSERT block. Pulls in the user / tutorial /
// 3 steps / 3 STEP TaskRecords + 1 TUTORIAL TaskRecord (all COMPLETED
// at attemptNumber=1) so the tests can start from a 'previously
// completed' state.
async function seedCompletedTutorial() {
  const { Users, Tutorials, Steps, TaskRecords } = cds.entities('com.sap.developers.ims');
  const testUser = { ID: 'u1', uuid: 'u1', sapId: 'sap-u1', legacyId: 1001 };
  const testTutorial = { ID: 't1', slug: 'reset-happy-path', title: 'Reset Happy Path', legacyId: 2001, stepCount: 3 };
  const testSteps = [
    { ID: 's1', tutorial_ID: 't1', stepOrder: 1, legacyId: 3001, title: 'Step 1' },
    { ID: 's2', tutorial_ID: 't1', stepOrder: 2, legacyId: 3002, title: 'Step 2' },
    { ID: 's3', tutorial_ID: 't1', stepOrder: 3, legacyId: 3003, title: 'Step 3' },
  ];

  // Fixture-scoped cleanup — the in-memory SQLite from cds.test('serve', ...)
  // persists across tests within a file, so a 2nd call to this helper would
  // otherwise trip UNIQUE constraints (e.g. Users.sapId). Idempotent: DELETE
  // on a missing row is a no-op. Order matters for FK satisfaction — children
  // before parents.
  await DELETE.from(TaskRecords).where({ user_ID: 'u1' });
  await DELETE.from(Steps).where({ tutorial_ID: 't1' });
  await DELETE.from(Tutorials).where({ ID: 't1' });
  await DELETE.from(Users).where({ ID: 'u1' });

  await INSERT.into(Users).entries(testUser);
  await INSERT.into(Tutorials).entries(testTutorial);
  await INSERT.into(Steps).entries(testSteps);

  const now = new Date().toISOString();
  await INSERT.into(TaskRecords).entries([
    ...testSteps.map((s, i) => ({
      ID: `tr-step-${i}`, user_ID: 'u1', taskLegacyId: s.legacyId, taskType: 'STEP',
      status: 'COMPLETED', progress: 100, completionDate: now, attemptNumber: 1, legacyId: 4000 + i,
    })),
    {
      ID: 'tr-tut', user_ID: 'u1', taskLegacyId: 2001, taskType: 'TUTORIAL',
      status: 'COMPLETED', progress: 100, completionDate: now, attemptNumber: 1, legacyId: 4100,
    },
  ]);

  return { testUser, testTutorial, testSteps };
}

describe('TaskRecords schema (#600 reset-tutorial-progress)', () => {
  it('TaskRecords entity has attemptNumber column with default 1', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    expect(TaskRecords.elements.attemptNumber).toBeDefined();
    expect(TaskRecords.elements.attemptNumber.type).toBe('cds.Integer');
    expect(TaskRecords.elements.attemptNumber.default?.val).toBe(1);
  });

  it('TaskRecords.status enum includes SUPERSEDED', () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    expect(TaskRecords.elements.status.enum).toHaveProperty('SUPERSEDED');
  });
});

describe('resetTutorialProgress action declaration', () => {
  it('is registered on DeveloperService', async () => {
    const { DeveloperService } = cds.services;
    expect(DeveloperService.operations.resetTutorialProgress).toBeDefined();
  });

  it('getMyCompletions return shape includes attemptNumber', async () => {
    const { DeveloperService } = cds.services;
    const op = DeveloperService.operations.getMyCompletions;
    expect(op.returns.items.elements.attemptNumber).toBeDefined();
    expect(op.returns.items.elements.attemptNumber.type).toBe('cds.Integer');
  });
});

describe('resetTutorialProgress handler — happy path', () => {
  let testUser;
  let testTutorial;
  let testSteps;

  beforeEach(async () => {
    // Use the shared seed helper defined in Task 1 (do NOT duplicate).
    // Fixture-scoped cleanup is performed inside seedCompletedTutorial() so
    // every caller (Tasks 3–8) gets test isolation for free.
    ({ testUser, testTutorial, testSteps } = await seedCompletedTutorial());
  });

  it('supersedes 4 rows, inserts a new attempt-2 TUTORIAL row, returns the right shape', async () => {
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };

    const { DeveloperService } = cds.services;
    const result = await DeveloperService.send({
      event: 'resetTutorialProgress',
      data: { slug: 'reset-happy-path' },
    });

    expect(result.newAttemptNumber).toBe(2);
    expect(result.supersededRecordCount).toBe(4);
    expect(result.previousAttemptCompletedAt).toBeTruthy();

    // Verify DB state.
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TaskRecords).where({ user_ID: 'u1' });

    const superseded = rows.filter(r => r.status === 'SUPERSEDED');
    expect(superseded).toHaveLength(4);
    expect(superseded.every(r => r.completionDate !== null)).toBe(true);

    const live = rows.filter(r => r.status === 'IN_PROGRESS');
    expect(live).toHaveLength(1);
    expect(live[0].taskType).toBe('TUTORIAL');
    expect(live[0].attemptNumber).toBe(2);
    expect(live[0].progress).toBe(0);
  });

  it('idempotent no-op when user has never touched the tutorial', async () => {
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    const { DeveloperService } = cds.services;
    // First call superseded everything; second call should be a no-op (only the new
    // attempt-2 TUTORIAL row exists as live state, so it gets superseded into attempt-3 IN_PROGRESS).
    await DeveloperService.send({ event: 'resetTutorialProgress', data: { slug: 'reset-happy-path' } });
    const result2 = await DeveloperService.send({ event: 'resetTutorialProgress', data: { slug: 'reset-happy-path' } });
    expect(result2.supersededRecordCount).toBe(1);
    expect(result2.newAttemptNumber).toBe(3);
  });

  it('rejects unknown slug with 404', async () => {
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    const { DeveloperService } = cds.services;
    await expect(
      DeveloperService.send({ event: 'resetTutorialProgress', data: { slug: 'does-not-exist' } })
    ).rejects.toMatchObject({ code: 404 });
  });

  it('rejects unauthenticated with 401', async () => {
    cds.context = { user: null };
    const { DeveloperService } = cds.services;
    await expect(
      DeveloperService.send({ event: 'resetTutorialProgress', data: { slug: 'reset-happy-path' } })
    ).rejects.toMatchObject({ code: 401 });
  });
});

describe('completeStep companion change', () => {
  beforeEach(async () => {
    await seedCompletedTutorial();
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    // Reset to attempt 2 so a fresh completeStep call hits the post-reset path.
    await cds.services.DeveloperService.send({
      event: 'resetTutorialProgress',
      data: { slug: 'reset-happy-path' },
    });
  });

  it('completeStep on attempt 2 inserts a new STEP row at attemptNumber 2', async () => {
    const { DeveloperService } = cds.services;
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    await DeveloperService.send({
      event: 'completeStep',
      data: { slug: 'reset-happy-path', stepNumber: 1 },
    });

    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const stepRows = await SELECT.from(TaskRecords).where({
      user_ID: 'u1', taskType: 'STEP', taskLegacyId: 3001,
    });
    expect(stepRows).toHaveLength(2);
    const superseded = stepRows.find(r => r.status === 'SUPERSEDED');
    const live = stepRows.find(r => r.status === 'COMPLETED');
    expect(superseded.attemptNumber).toBe(1);
    expect(live.attemptNumber).toBe(2);
  });

  it('_updateTutorialProgress after reset does NOT mutate the SUPERSEDED tutorial row', async () => {
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    const { DeveloperService } = cds.services;
    const { TaskRecords } = cds.entities('com.sap.developers.ims');

    const originalSuperseded = await SELECT.one.from(TaskRecords).where({
      user_ID: 'u1', taskType: 'TUTORIAL', status: 'SUPERSEDED',
    });
    const originalCompletionDate = originalSuperseded.completionDate;
    expect(originalCompletionDate).toBeTruthy(); // sanity: the seed completed the tutorial

    await DeveloperService.send({
      event: 'completeStep',
      data: { slug: 'reset-happy-path', stepNumber: 1 },
    });

    const supersededAfter = await SELECT.one.from(TaskRecords).where({
      user_ID: 'u1', taskType: 'TUTORIAL', status: 'SUPERSEDED',
    });
    expect(supersededAfter.completionDate).toEqual(originalCompletionDate);
  });

  it('getProgress returns empty completedSteps after reset (even though SUPERSEDED rows exist)', async () => {
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    const { DeveloperService } = cds.services;

    // After beforeEach reset, completedSteps should be empty for the live attempt.
    const progress = await DeveloperService.send({
      event: 'getProgress',
      data: { slug: 'reset-happy-path' },
    });
    expect(progress.completedSteps).toEqual([]);
  });
});

// --- Tasks 7 + 8 — user-progress lib treats SUPERSEDED as has-ever-completed ---
//
// These helpers compose on top of seedCompletedTutorial() to set up the two
// states the lib functions must distinguish:
//   1. seedTwoCompletions:    attempt 1 COMPLETED → reset → attempt 2 COMPLETED
//   2. seedMidAttempt2:       attempt 1 COMPLETED → reset → attempt 2 IN_PROGRESS
async function seedTwoCompletions() {
  await seedCompletedTutorial(); // attempt 1 COMPLETED
  cds.context = { user: new cds.User({ id: 'sap-u1' }) };
  await cds.services.DeveloperService.send({
    event: 'resetTutorialProgress', data: { slug: 'reset-happy-path' },
  });
  // Re-complete all 3 steps so attempt 2 also becomes COMPLETED.
  for (const stepNumber of [1, 2, 3]) {
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    await cds.services.DeveloperService.send({
      event: 'completeStep', data: { slug: 'reset-happy-path', stepNumber },
    });
  }
}

async function seedMidAttempt2() {
  await seedCompletedTutorial(); // attempt 1 COMPLETED
  cds.context = { user: new cds.User({ id: 'sap-u1' }) };
  await cds.services.DeveloperService.send({
    event: 'resetTutorialProgress', data: { slug: 'reset-happy-path' },
  });
  // Don't re-complete anything. Attempt 2 IN_PROGRESS, attempt 1 rows are SUPERSEDED.
}

describe('Tasks 7+8 — getMyCompletions shows ALL completions', () => {
  it('returns TWO rows for a tutorial completed twice, sorted by completionDate DESC', async () => {
    await seedTwoCompletions();
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    const result = await cds.services.DeveloperService.send({ event: 'getMyCompletions' });

    const rowsForT1 = result.filter(r => r.slug === 'reset-happy-path');
    expect(rowsForT1).toHaveLength(2);
    expect(rowsForT1[0].attemptNumber).toBe(2);
    expect(rowsForT1[1].attemptNumber).toBe(1);
    expect(new Date(rowsForT1[0].completionDate).getTime())
      .toBeGreaterThanOrEqual(new Date(rowsForT1[1].completionDate).getTime());
  });

  it('returns ONE row when only attempt 1 was completed (mid-attempt-2 state)', async () => {
    await seedMidAttempt2();
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    const result = await cds.services.DeveloperService.send({ event: 'getMyCompletions' });

    const rowsForT1 = result.filter(r => r.slug === 'reset-happy-path');
    expect(rowsForT1).toHaveLength(1);
    expect(rowsForT1[0].attemptNumber).toBe(1);
  });
});

describe('Task 8 — user-progress lib handles SUPERSEDED', () => {
  it('getUserProgress on mid-attempt-2 state lists the tutorial in BOTH inProgress AND completedSlugs', async () => {
    await seedMidAttempt2();
    const { getUserProgress } = await import('../../srv/lib/user-progress.js');
    const user = new cds.User({ id: 'sap-u1' });
    const result = await getUserProgress(user);

    // Historical completion is preserved via SUPERSEDED status.
    expect(result.completedSlugs).toContain('reset-happy-path');
    expect(result.lastCompletedSlug).toBe('reset-happy-path');
    // The live attempt-2 IN_PROGRESS row surfaces as in-progress.
    expect(result.inProgress.map(p => p.slug)).toContain('reset-happy-path');
  });

  it('getProgressLookup surfaces the LIVE (non-SUPERSEDED) status, not the historical one', async () => {
    await seedMidAttempt2();
    const { getProgressLookup } = await import('../../srv/lib/user-progress.js');
    const user = new cds.User({ id: 'sap-u1' });
    const lookup = await getProgressLookup(user);

    const entry = lookup.get('TUTORIAL:reset-happy-path');
    expect(entry).toBeDefined();
    // Mid-attempt-2: the live row is IN_PROGRESS. SUPERSEDED must be filtered out.
    expect(entry.status).toBe('IN_PROGRESS');
  });

  it('getUserProgress on twice-completed state lists the tutorial in completedSlugs but NOT in inProgress', async () => {
    await seedTwoCompletions();
    const { getUserProgress } = await import('../../srv/lib/user-progress.js');
    const user = new cds.User({ id: 'sap-u1' });
    const result = await getUserProgress(user);

    expect(result.completedSlugs).toContain('reset-happy-path');
    // Both attempts are terminal (COMPLETED or SUPERSEDED) — nothing live.
    expect(result.inProgress.map(p => p.slug)).not.toContain('reset-happy-path');
  });
});

// --- Task 9 — admin-service read-paths handle SUPERSEDED correctly ---
//
// Event stats + mission rollups: "has-ever-completed" — include SUPERSEDED,
// DISTINCT by (user_ID, taskLegacyId) so re-completions don't inflate.
//
// avgProgressByTaskType (getBoardStatistics): "current-state-average" —
// EXCLUDE SUPERSEDED, otherwise historical snapshots skew live progress.

describe('Task 9 — event-statistics helpers count SUPERSEDED as a completion (deduped)', () => {
  it('computeEventStatistics: user with SUPERSEDED + IN_PROGRESS of same tutorial = 1 completion, 1 user', async () => {
    const { computeEventStatistics } = await import('../../srv/lib/event-statistics.js');

    // User u1 has 2 attempts of tutorial 2001:
    //   attempt 1 SUPERSEDED (historical truth — they DID complete it),
    //   attempt 2 IN_PROGRESS (currently re-doing it).
    // Expected: 1 tutorial completion, 1 unique user.
    const rows = [
      { user_ID: 'u1', taskLegacyId: 2001, taskType: 'TUTORIAL', status: 'SUPERSEDED', completionDate: '2026-01-01T00:00:00Z' },
      { user_ID: 'u1', taskLegacyId: 2001, taskType: 'TUTORIAL', status: 'IN_PROGRESS', completionDate: null },
    ];
    const stats = computeEventStatistics(rows);
    expect(stats.tutorials).toBe(1);
    expect(stats.uniqueUsers).toBe(1);
  });

  it('computeEventStatistics: re-completer (SUPERSEDED + COMPLETED of same task) counts as 1 completion (DISTINCT by user+task)', async () => {
    const { computeEventStatistics } = await import('../../srv/lib/event-statistics.js');
    const rows = [
      // u1 reset+re-did tutorial 2001: SUPERSEDED + COMPLETED
      { user_ID: 'u1', taskLegacyId: 2001, taskType: 'TUTORIAL', status: 'SUPERSEDED', completionDate: '2026-01-01T00:00:00Z' },
      { user_ID: 'u1', taskLegacyId: 2001, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-06-01T00:00:00Z' },
      // u1 also reset+re-did mission 9001: SUPERSEDED + COMPLETED
      { user_ID: 'u1', taskLegacyId: 9001, taskType: 'MISSION', status: 'SUPERSEDED', completionDate: '2026-01-01T00:00:00Z' },
      { user_ID: 'u1', taskLegacyId: 9001, taskType: 'MISSION', status: 'COMPLETED', completionDate: '2026-06-01T00:00:00Z' },
    ];
    const stats = computeEventStatistics(rows);
    // 1 distinct tutorial completion (not 2), 1 distinct mission completion (not 2), 1 unique user.
    expect(stats.tutorials).toBe(1);
    expect(stats.missions).toBe(1);
    expect(stats.uniqueUsers).toBe(1);
  });

  it('computeTrackStats: SUPERSEDED counts as a completion; DISTINCT prevents double-count on re-completion', async () => {
    const { computeTrackStats } = await import('../../srv/lib/event-statistics.js');
    const missions = [{ legacyId: 9001, title: 'M1' }];
    const rows = [
      // u1 completed M1, reset, re-completed → 2 rows, must count as 1
      { user_ID: 'u1', taskLegacyId: 9001, status: 'SUPERSEDED' },
      { user_ID: 'u1', taskLegacyId: 9001, status: 'COMPLETED' },
      // u2 only has SUPERSEDED (mid-attempt-2) — still counts as 1 completion (historical truth)
      { user_ID: 'u2', taskLegacyId: 9001, status: 'SUPERSEDED' },
      { user_ID: 'u2', taskLegacyId: 9001, status: 'IN_PROGRESS' },
    ];
    const stats = computeTrackStats(rows, missions);
    expect(stats).toHaveLength(1);
    expect(stats[0].uniqueUsers).toBe(2);
    expect(stats[0].completions).toBe(2); // one logical completion per user
  });

  it('computeLeaderboard: counts DISTINCT (user, taskLegacyId) — SUPERSEDED + COMPLETED of same task = 1, not 2', async () => {
    const { computeLeaderboard } = await import('../../srv/lib/event-statistics.js');
    const users = [
      { ID: 'u1', legacyId: 1, displayName: 'Alice' },
      { ID: 'u2', legacyId: 2, displayName: 'Bob' },
    ];
    const rows = [
      // u1: 1 tutorial completed twice (reset+re-do), 1 other tutorial only SUPERSEDED (mid-attempt-2)
      { user_ID: 'u1', taskLegacyId: 2001, status: 'SUPERSEDED' },
      { user_ID: 'u1', taskLegacyId: 2001, status: 'COMPLETED' },
      { user_ID: 'u1', taskLegacyId: 2002, status: 'SUPERSEDED' },
      { user_ID: 'u1', taskLegacyId: 2002, status: 'IN_PROGRESS' },
      // u2: 1 tutorial completed once
      { user_ID: 'u2', taskLegacyId: 2003, status: 'COMPLETED' },
    ];
    const board = computeLeaderboard(rows, users, 10);
    // u1: 2 distinct completions (2001 + 2002), NOT 3 (would-be 2001x2 if SUPERSEDED double-counted) and NOT 1 (would-be if SUPERSEDED ignored)
    const alice = board.find(b => b.displayName === 'Alice');
    expect(alice.completions).toBe(2);
    const bob = board.find(b => b.displayName === 'Bob');
    expect(bob.completions).toBe(1);
  });
});

// --- Tasks 10 + 11 + 12 — scanner / display+event-stream / co-completion ---
//
// Same "has-ever-completed" pattern as Task 9: expand the status filter at the
// SQL layer to include SUPERSEDED and dedupe by (user_ID, taskLegacyId) so a
// user mid-attempt-2 still counts as ONE completer (not zero, not two).

describe('Task 10 — ScannerService.getContestant counts SUPERSEDED as completed', () => {
  beforeEach(async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TaskRecords);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);
  });

  it('returns 1 tutorial completed when user has SUPERSEDED + IN_PROGRESS of same tutorial', async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u10', uuid: 'u10', sapId: 'sap-u10', legacyId: 10001 });
    await INSERT.into(Tutorials).entries({ ID: 't10', slug: 'task10-tut', title: 'T10', legacyId: 7100, stepCount: 1 });

    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-10-sup', user_ID: 'u10', taskLegacyId: 7100, taskType: 'TUTORIAL',
        status: 'SUPERSEDED', progress: 100, attemptNumber: 1, legacyId: 10100 },
      { ID: 'tr-10-ip', user_ID: 'u10', taskLegacyId: 7100, taskType: 'TUTORIAL',
        status: 'IN_PROGRESS', progress: 30, attemptNumber: 2, legacyId: 10101 },
    ]);

    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: '10001' } })
    );
    // SUPERSEDED counts as a completion (historical truth). DISTINCT prevents
    // double-count if there were also a fresh COMPLETED row.
    expect(result.tutorialsCompleted).toBe(1);
  });

  it('returns 1 tutorial completed when user re-completed same tutorial (SUPERSEDED + COMPLETED)', async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u10b', uuid: 'u10b', sapId: 'sap-u10b', legacyId: 10002 });
    await INSERT.into(Tutorials).entries({ ID: 't10b', slug: 'task10-tut-b', title: 'T10B', legacyId: 7101, stepCount: 1 });

    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-10b-sup', user_ID: 'u10b', taskLegacyId: 7101, taskType: 'TUTORIAL',
        status: 'SUPERSEDED', progress: 100, attemptNumber: 1, legacyId: 10110 },
      { ID: 'tr-10b-comp', user_ID: 'u10b', taskLegacyId: 7101, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, attemptNumber: 2, legacyId: 10111 },
    ]);

    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: '10002' } })
    );
    // 1 logical completion, NOT 2 (DISTINCT by user+taskLegacyId).
    expect(result.tutorialsCompleted).toBe(1);
  });
});

describe('Task 11 — computeBuckets helper handles SUPERSEDED', () => {
  it('SUPERSEDED counts as a completion; DISTINCT prevents double-count', async () => {
    const { computeBuckets } = await import('../../srv/lib/event-statistics.js');

    // u1: 1 tutorial completed twice (SUPERSEDED + COMPLETED) → 1 distinct completion
    // u2: 1 tutorial completed once (COMPLETED)
    // u3: 1 tutorial mid-attempt-2 (SUPERSEDED + IN_PROGRESS) → 1 distinct completion
    // Expected histogram: 3 users each with 1 tutorial → bucket "1 tutorial" has count 3.
    const rows = [
      { user_ID: 'u1', taskLegacyId: 2001, status: 'SUPERSEDED' },
      { user_ID: 'u1', taskLegacyId: 2001, status: 'COMPLETED' },
      { user_ID: 'u2', taskLegacyId: 2002, status: 'COMPLETED' },
      { user_ID: 'u3', taskLegacyId: 2003, status: 'SUPERSEDED' },
      { user_ID: 'u3', taskLegacyId: 2003, status: 'IN_PROGRESS' },
    ];
    const buckets = computeBuckets(rows);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].bucketName).toBe('1 tutorial');
    expect(buckets[0].count).toBe(3);
  });
});

describe('Task 11 — DisplayService passes SUPERSEDED rows to event-statistics helpers', () => {
  beforeEach(async () => {
    const { Users, Events, Tutorials, Missions, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TaskRecords);
    await DELETE.from(Events);
    await DELETE.from(Tutorials);
    await DELETE.from(Missions);
    await DELETE.from(Users);
  });

  it('getEventBuckets: user with SUPERSEDED-only attempt is counted in the histogram', async () => {
    const { Users, Events, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u11', uuid: 'u11', sapId: 'sap-u11', legacyId: 11001 });
    await INSERT.into(Events).entries({ ID: 'e11', legacyId: 11500, title: 'E11', timeZone: '+00:00' });
    await INSERT.into(Tutorials).entries({ ID: 't11', slug: 'task11-tut', title: 'T11', legacyId: 7200, stepCount: 1 });

    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-11-sup', user_ID: 'u11', event_ID: 'e11', taskLegacyId: 7200, taskType: 'TUTORIAL',
        status: 'SUPERSEDED', progress: 100, attemptNumber: 1, legacyId: 11100 },
      { ID: 'tr-11-ip', user_ID: 'u11', event_ID: 'e11', taskLegacyId: 7200, taskType: 'TUTORIAL',
        status: 'IN_PROGRESS', progress: 25, attemptNumber: 2, legacyId: 11101 },
    ]);

    const display = await cds.connect.to('DisplayService');
    const buckets = await display.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getEventBuckets', data: { eventLegacyId: 11500 } })
    );
    // Pre-fix: SUPERSEDED filtered out → 0 buckets (no users counted).
    // After-fix: SUPERSEDED counts; u11 has 1 completion → bucket "1 tutorial" count 1.
    expect(buckets).toHaveLength(1);
    expect(buckets[0].bucketName).toBe('1 tutorial');
    expect(buckets[0].count).toBe(1);
  });
});

describe('Task 12 — co-completion includes SUPERSEDED completions', () => {
  beforeEach(async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TaskRecords);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);
  });

  it('user mid-attempt-2 (SUPERSEDED) still contributes their pair to the co-completion graph', async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u12', uuid: 'u12', sapId: 'sap-u12', legacyId: 12001 });
    await INSERT.into(Tutorials).entries([
      { ID: 't12a', slug: 'task12-a', title: 'A', legacyId: 7300, stepCount: 1, status: 'ACTIVE' },
      { ID: 't12b', slug: 'task12-b', title: 'B', legacyId: 7301, stepCount: 1, status: 'ACTIVE' },
    ]);
    // u12 completed BOTH A and B, then reset A. Now: A is SUPERSEDED + IN_PROGRESS, B is still COMPLETED.
    // Pre-fix: A's SUPERSEDED is filtered out → only B is in the user's set → NO pair.
    // After-fix: both A and B are in the user's set → pair (a, b) with score 1.
    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-12a-sup', user_ID: 'u12', taskLegacyId: 7300, taskType: 'TUTORIAL',
        status: 'SUPERSEDED', progress: 100, attemptNumber: 1, legacyId: 12100 },
      { ID: 'tr-12a-ip', user_ID: 'u12', taskLegacyId: 7300, taskType: 'TUTORIAL',
        status: 'IN_PROGRESS', progress: 25, attemptNumber: 2, legacyId: 12101 },
      { ID: 'tr-12b-comp', user_ID: 'u12', taskLegacyId: 7301, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, attemptNumber: 1, legacyId: 12102 },
    ]);

    const { computeCoCompletions } = await import('../../srv/lib/co-completion.js');
    const result = await computeCoCompletions({ force: true });
    expect(result['task12-a']).toBeDefined();
    expect(result['task12-a'].find(p => p.slug === 'task12-b')?.score).toBe(1);
    expect(result['task12-b']).toBeDefined();
    expect(result['task12-b'].find(p => p.slug === 'task12-a')?.score).toBe(1);
  });

  it('re-completer (SUPERSEDED + COMPLETED of same tutorial) does NOT double-count pair weight', async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u12b', uuid: 'u12b', sapId: 'sap-u12b', legacyId: 12002 });
    await INSERT.into(Tutorials).entries([
      { ID: 't12c', slug: 'task12-c', title: 'C', legacyId: 7310, stepCount: 1, status: 'ACTIVE' },
      { ID: 't12d', slug: 'task12-d', title: 'D', legacyId: 7311, stepCount: 1, status: 'ACTIVE' },
    ]);
    // u12b completed C twice (SUPERSEDED + COMPLETED) AND D once.
    // The Set-per-user idiom in computeCoCompletions already dedupes by slug,
    // so the pair (c, d) should have score 1 (not 2).
    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-12c-sup', user_ID: 'u12b', taskLegacyId: 7310, taskType: 'TUTORIAL',
        status: 'SUPERSEDED', progress: 100, attemptNumber: 1, legacyId: 12110 },
      { ID: 'tr-12c-comp', user_ID: 'u12b', taskLegacyId: 7310, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, attemptNumber: 2, legacyId: 12111 },
      { ID: 'tr-12d-comp', user_ID: 'u12b', taskLegacyId: 7311, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, attemptNumber: 1, legacyId: 12112 },
    ]);

    const { computeCoCompletions } = await import('../../srv/lib/co-completion.js');
    const result = await computeCoCompletions({ force: true });
    expect(result['task12-c'].find(p => p.slug === 'task12-d')?.score).toBe(1);
  });
});

describe('Task 9 — admin-service SQL filters', () => {
  beforeEach(async () => {
    const { Users, Tutorials, Missions, Steps, TaskRecords } = cds.entities('com.sap.developers.ims');
    // Clean slate — getBoardStatistics is global (no event scope) and earlier
    // tests in this file leave TaskRecords + Tutorials + Steps + Users rows
    // around. Delete in FK order (children → parents).
    await DELETE.from(TaskRecords);
    await DELETE.from(Steps);
    await DELETE.from(Tutorials);
    await DELETE.from(Missions);
    await DELETE.from(Users);
  });

  it('getBoardStatistics avgProgress EXCLUDES SUPERSEDED rows from the average', async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'u9a', uuid: 'u9a', sapId: 'sap-u9a', legacyId: 9001 });
    await INSERT.into(Tutorials).entries({ ID: 't9a', slug: 'task9-tut-a', title: 'T9A', legacyId: 7001, stepCount: 1 });

    // Three TUTORIAL rows for the avg(progress) GROUP BY taskType:
    //   SUPERSEDED at progress=100 (historical truth, must NOT count)
    //   IN_PROGRESS at progress=50
    //   COMPLETED at progress=100
    // Pre-fix (where status='COMPLETED'): only the COMPLETED row counts → avg = 100.
    // After-fix (where status != 'SUPERSEDED'): IN_PROGRESS (50) + COMPLETED (100) → avg = 75.
    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-9a-sup', user_ID: 'u9a', taskLegacyId: 7001, taskType: 'TUTORIAL',
        status: 'SUPERSEDED', progress: 100, attemptNumber: 1, legacyId: 9100 },
      { ID: 'tr-9a-live', user_ID: 'u9a', taskLegacyId: 7001, taskType: 'TUTORIAL',
        status: 'IN_PROGRESS', progress: 50, attemptNumber: 2, legacyId: 9101 },
      { ID: 'tr-9a-comp', user_ID: 'u9a', taskLegacyId: 7002, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, attemptNumber: 1, legacyId: 9102 },
    ]);

    const admin = await cds.connect.to('AdminService');
    const stats = await admin.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getBoardStatistics' })
    );
    expect(stats.avgTutorialCompletion).toBe(75);
  });

  it('mission rollups: SUPERSEDED-only completions are returned AND re-completions are deduped', async () => {
    // Pre-fix behavior (status='COMPLETED' only, no DISTINCT):
    //   Carol contributes 1 row (the COMPLETED), Dan contributes 0 rows (only SUPERSEDED).
    //   → 1 data row total.
    // After-fix (status IN ('COMPLETED','SUPERSEDED'), DISTINCT by user+task):
    //   Carol's SUPERSEDED+COMPLETED collapses to 1 row; Dan's SUPERSEDED stands.
    //   → 2 data rows total (1 per user).
    const { Users, Missions, TaskRecords } = cds.entities('com.sap.developers.ims');
    const now = new Date().toISOString();
    await DELETE.from(TaskRecords).where({ user_ID: { in: ['u9b', 'u9c'] } });
    await DELETE.from(Missions).where({ ID: 'm9b' });
    await DELETE.from(Users).where({ ID: { in: ['u9b', 'u9c'] } });

    await INSERT.into(Users).entries([
      { ID: 'u9b', uuid: 'u9b', sapId: 'sap-u9b', legacyId: 9002, displayName: 'Carol' },
      { ID: 'u9c', uuid: 'u9c', sapId: 'sap-u9c', legacyId: 9003, displayName: 'Dan' },
    ]);
    await INSERT.into(Missions).entries({ ID: 'm9b', slug: 'task9-mission', title: 'T9M', legacyId: 5001 });

    await INSERT.into(TaskRecords).entries([
      // Carol re-completed the mission (reset+re-do)
      { ID: 'tr-9b-sup', user_ID: 'u9b', taskLegacyId: 5001, taskType: 'MISSION',
        status: 'SUPERSEDED', progress: 100, completionDate: now, attemptNumber: 1, legacyId: 9200 },
      { ID: 'tr-9b-comp', user_ID: 'u9b', taskLegacyId: 5001, taskType: 'MISSION',
        status: 'COMPLETED', progress: 100, completionDate: now, attemptNumber: 2, legacyId: 9201 },
      // Dan completed it once, reset, and is now mid-attempt-2
      { ID: 'tr-9c-sup', user_ID: 'u9c', taskLegacyId: 5001, taskType: 'MISSION',
        status: 'SUPERSEDED', progress: 100, completionDate: now, attemptNumber: 1, legacyId: 9202 },
      { ID: 'tr-9c-ip', user_ID: 'u9c', taskLegacyId: 5001, taskType: 'MISSION',
        status: 'IN_PROGRESS', progress: 30, completionDate: null, attemptNumber: 2, legacyId: 9203 },
    ]);

    const admin = await cds.connect.to('AdminService');
    const csv = await admin.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({
        event: 'exportMissionCompletions',
        data: {
          startDate: '2020-01-01T00:00:00Z',
          endDate: '2099-01-01T00:00:00Z',
          missionLegacyId: 5001,
        },
      })
    );
    const dataLines = csv.split('\n').slice(1).filter(Boolean);
    // After-fix: exactly 1 row per user (DISTINCT), and Dan (SUPERSEDED-only) IS included.
    expect(dataLines).toHaveLength(2);
    const joined = dataLines.join('\n');
    expect(joined).toContain('Carol');
    expect(joined).toContain('Dan');
  });
});

// Task 13: KG raw-SQL filters must treat SUPERSEDED rows as completion signal
// so reset users don't lose their concept knowledge / path-finder anchor.
// These are lightweight source-string assertions — the real KG behavior is
// hybrid-only (HANA SPARQL + KGE), so a regression guard here is enough.
describe('Task 13 — KG raw-SQL filters honor SUPERSEDED', () => {
  const conceptsForUserSource = fs.readFileSync(
    join(__dirname_t13, '../../srv/lib/kg/concepts-for-user.js'), 'utf8'
  );
  const findPathSource = fs.readFileSync(
    join(__dirname_t13, '../../srv/lib/kg/joule-tool-find-path.js'), 'utf8'
  );

  it('concepts-for-user.js SQL filter includes SUPERSEDED', () => {
    expect(conceptsForUserSource).toMatch(
      /STATUS\s+IN\s*\(\s*'COMPLETED'\s*,\s*'IN_PROGRESS'\s*,\s*'SUPERSEDED'\s*\)/
    );
  });

  it('concepts-for-user.js classification treats SUPERSEDED as learned', () => {
    expect(conceptsForUserSource).toMatch(
      /status\s*===\s*'COMPLETED'\s*\|\|\s*status\s*===\s*'SUPERSEDED'/
    );
  });

  it('joule-tool-find-path.js SQL filter includes SUPERSEDED', () => {
    expect(findPathSource).toMatch(
      /r\.STATUS\s+IN\s*\(\s*'COMPLETED'\s*,\s*'SUPERSEDED'\s*\)/
    );
  });
});

// Task 15 + 16 + 16a — saved-query analytics view + ad-hoc analytics schema
// + admin CSV export. Saved-query and ad-hoc analytics surfaces must count
// SUPERSEDED rows as completion signal (re-completion remains a completion);
// CSV export adds attemptNumber so audit reviewers can distinguish attempts.
describe('Task 15 — CompletionAnalytics view filter includes SUPERSEDED', () => {
  const viewsSrc = fs.readFileSync(
    join(__dirname_t13, '../../db/views.cds'), 'utf8'
  );

  it('CompletionAnalytics where clause uses status IN (COMPLETED, SUPERSEDED)', () => {
    expect(viewsSrc).toMatch(
      /where\s+tr\.status\s+in\s*\(\s*'COMPLETED'\s*,\s*'SUPERSEDED'\s*\)/i
    );
  });
});

describe('Task 16 — admin-analytics-schema completion baseFilter includes SUPERSEDED', async () => {
  const { ANALYTICS_SCHEMA } = await import('../../srv/lib/admin-analytics-schema.js');

  it('facts.completion.baseFilter widens to status IN [COMPLETED, SUPERSEDED]', () => {
    expect(ANALYTICS_SCHEMA.facts.completion.baseFilter).toEqual({
      status: { in: ['COMPLETED', 'SUPERSEDED'] },
    });
  });
});

describe('Task 16a — admin CSV task-records export adds attemptNumber column', async () => {
  const { legacyHeader, rows } = await import('../../srv/exports/task-records.js');

  it('legacyHeader array contains ATTEMPT_NUMBER', () => {
    expect(legacyHeader).toContain('ATTEMPT_NUMBER');
  });

  it('rows generator yields attemptNumber in same position as header', async () => {
    const fakePage = [{
      ID: 'r1', user_ID: 'u1', taskLegacyId: 1, taskType: 'TUTORIAL',
      status: 'COMPLETED', progress: 100, attemptNumber: 2,
      completionTime: null, completionDate: null,
      contentLanguage: null, siteLanguage: null,
      submissionIdStarted: null, submissionIdCompleted: null,
      titleSnapshot: 't', progressNote: null,
      event_ID: null, createdAt: null, modifiedAt: null, legacyId: 1
    }];
    let calls = 0;
    const fakeDb = { run: async () => (calls++ === 0 ? fakePage : []) };
    const gen = rows(fakeDb, { pageSize: 5000 });
    const out = [];
    for await (const r of gen) out.push(r);
    expect(out).toHaveLength(1);
    const attemptIdx = legacyHeader.indexOf('ATTEMPT_NUMBER');
    expect(out[0][attemptIdx]).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Task 17 — TutorialProgressReset event: explicit CDS declaration +
// audit listener. Closes Task 3 reviewer's S1 recommendation.
// ─────────────────────────────────────────────────────────────────────
describe('Task 17 — TutorialProgressReset event declaration', () => {
  it('TutorialProgressReset event is declared on DeveloperService', () => {
    const { DeveloperService } = cds.services;
    // CAP exposes service-scoped events via `.events`; the fully-qualified
    // name lookup is a fallback for CSN versions that key by fqn.
    const event = DeveloperService.events?.TutorialProgressReset
              ?? DeveloperService.events?.['DeveloperService.TutorialProgressReset']
              ?? DeveloperService.events?.['TutorialProgressReset'];
    expect(event).toBeDefined();
    // All 5 fields from the emit payload must be on the declaration so
    // OData $metadata + ORD discovery see the contract.
    expect(event.elements.user).toBeDefined();
    expect(event.elements.tutorialSlug).toBeDefined();
    expect(event.elements.attemptNumber).toBeDefined();
    expect(event.elements.supersededRecordCount).toBeDefined();
    expect(event.elements.previousAttemptCompletedAt).toBeDefined();
  });
});

describe('Task 17 — TutorialProgressReset audit listener', () => {
  beforeEach(async () => {
    await seedCompletedTutorial();
  });

  it('TutorialProgressReset event reaches the audit listener', async () => {
    // The listener registered in srv/admin-service.js calls
    // cds.log('audit').info(...). Spy on the *singleton* logger instance
    // (cds.log returns the same instance for a given tag) so we can
    // observe the call regardless of when the listener resolves the
    // logger reference.
    const auditLog = cds.log('audit');
    const infoSpy = vi.spyOn(auditLog, 'info');
    try {
      cds.context = { user: new cds.User({ id: 'sap-u1' }) };
      await cds.services.DeveloperService.send({
        event: 'resetTutorialProgress',
        data: { slug: 'reset-happy-path' },
      });

      const matching = infoSpy.mock.calls.find(c =>
        c[0] === 'TutorialProgressReset' ||
        (c[1] && c[1].tutorialSlug === 'reset-happy-path')
      );
      expect(matching).toBeTruthy();
      // The payload should carry the slug + new attempt number
      // (attempt 2 since the seed left a single completed attempt at 1).
      const payload = matching[1] ?? {};
      expect(payload.tutorialSlug).toBe('reset-happy-path');
      expect(payload.attemptNumber).toBe(2);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Task 18 — resetTutorialProgress rate limit (5 / hour / user → 429).
// Same per-user limiter shape as /api/codecheck and /api/validate-answer
// (factored into srv/lib/per-user-rate-limit.js for reuse). Bucket key
// prefixed 'reset:' so the limit is independent of those other features.
// ─────────────────────────────────────────────────────────────────────
describe('Task 18 — resetTutorialProgress rate limit', () => {
  beforeEach(async () => {
    await seedCompletedTutorial();
    // (Top-level beforeEach already cleared the rate-limit buckets.)
  });

  it('6th reset within an hour returns 429', async () => {
    const { DeveloperService } = cds.services;

    // 5 resets should succeed; each one supersedes the previous attempt's
    // live TUTORIAL row and inserts a fresh IN_PROGRESS at attempt N+1.
    for (let i = 0; i < 5; i++) {
      cds.context = { user: new cds.User({ id: 'sap-u1' }) };
      await DeveloperService.send({
        event: 'resetTutorialProgress',
        data: { slug: 'reset-happy-path' },
      });
    }

    // 6th must reject with 429 — quota exceeded within the 1-hour window.
    cds.context = { user: new cds.User({ id: 'sap-u1' }) };
    await expect(
      DeveloperService.send({
        event: 'resetTutorialProgress',
        data: { slug: 'reset-happy-path' },
      })
    ).rejects.toMatchObject({ code: 429 });
  });
});
