import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';

// Boots CAP with in-memory SQLite, deploys the model, and exposes
// SELECT/INSERT/UPDATE/DELETE as globals. Same pattern as
// test/unit/author-service.test.js — do NOT move this inside beforeAll;
// it has to bind at module-load so the schema is deployed before
// the describe blocks below try to read cds.entities(...).
const project = cds.test('serve', '--project', '.', '--in-memory');

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
});
