import { describe, it, expect } from 'vitest';
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
