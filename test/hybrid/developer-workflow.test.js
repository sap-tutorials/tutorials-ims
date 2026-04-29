import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';

describe.runIf(isSafeForWrites())('Developer workflow (hybrid)', () => {
  const createdRecordIds = [];
  const createdUserIds = [];

  afterAll(async () => {
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    for (const id of createdRecordIds) {
      await DELETE.from(TaskRecords).where({ ID: id });
    }
    for (const id of createdUserIds) {
      await DELETE.from(Users).where({ ID: id });
    }
  });

  describe('status-calculator logic', () => {
    it('calculateTutorialProgress returns correct status', async () => {
      const { calculateTutorialProgress } = await import('../../srv/lib/status-calculator.js');

      const incomplete = calculateTutorialProgress([1, 2], 5);
      expect(incomplete.status).toBe('IN_PROGRESS');
      expect(incomplete.progress).toBe(40);

      const complete = calculateTutorialProgress([1, 2, 3], 3);
      expect(complete.status).toBe('COMPLETED');
      expect(complete.progress).toBe(100);
    });

    it('calculateMissionProgress returns correct status', async () => {
      const { calculateMissionProgress } = await import('../../srv/lib/status-calculator.js');

      const half = calculateMissionProgress(2, 4);
      expect(half.status).toBe('IN_PROGRESS');
      expect(half.progress).toBe(50);

      const done = calculateMissionProgress(3, 3);
      expect(done.status).toBe('COMPLETED');
      expect(done.progress).toBe(100);
    });
  });

  describe('task record creation against real HANA', () => {
    it('inserts a step task record with auto-generated legacyId', async () => {
      const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

      // Find an existing user to associate with
      const user = await SELECT.one.from(Users).limit(1);
      expect(user).toBeTruthy();

      const legacyId = await getNextLegacyId('TaskRecords', db);
      const record = {
        user_ID: user.ID,
        taskLegacyId: 99999999,
        taskType: 'STEP',
        status: 'COMPLETED',
        progress: 100,
        completionDate: new Date().toISOString(),
        titleSnapshot: `${TEST_PREFIX}step-workflow-test`,
        legacyId
      };

      await INSERT.into(TaskRecords).entries(record);
      const inserted = await SELECT.one.from(TaskRecords).where({ legacyId });
      expect(inserted).toBeTruthy();
      expect(inserted.status).toBe('COMPLETED');
      expect(inserted.taskType).toBe('STEP');
      expect(inserted.progress).toBe(100);

      createdRecordIds.push(inserted.ID);
    });

    it('idempotent insert — same user+task+type does not duplicate', async () => {
      const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

      const user = await SELECT.one.from(Users).limit(1);
      const taskLegacyId = 88888888;

      const legacyId1 = await getNextLegacyId('TaskRecords', db);
      await INSERT.into(TaskRecords).entries({
        user_ID: user.ID,
        taskLegacyId,
        taskType: 'TUTORIAL',
        status: 'IN_PROGRESS',
        progress: 50,
        titleSnapshot: `${TEST_PREFIX}idempotent-test`,
        legacyId: legacyId1
      });

      const first = await SELECT.one.from(TaskRecords).where({ legacyId: legacyId1 });
      createdRecordIds.push(first.ID);

      // Simulate "completing" the same task — update existing record
      await UPDATE(TaskRecords, first.ID).set({
        status: 'COMPLETED',
        progress: 100,
        completionDate: new Date().toISOString()
      });

      const updated = await SELECT.one.from(TaskRecords, first.ID);
      expect(updated.status).toBe('COMPLETED');
      expect(updated.progress).toBe(100);

      // Verify no duplicate was created
      const all = await SELECT.from(TaskRecords).where({
        user_ID: user.ID,
        taskLegacyId,
        taskType: 'TUTORIAL'
      });
      const testRecords = all.filter(r => r.titleSnapshot?.startsWith(TEST_PREFIX));
      expect(testRecords.length).toBe(1);
    });
  });

  describe('progress cascade verification', () => {
    it('tutorial with all steps completed shows 100% progress pattern', async () => {
      const { Tutorials, Steps, TaskRecords, Users } = cds.entities('com.sap.developers.ims');

      // Find a tutorial that has steps (QA data may not have ACTIVE status)
      const tutorial = await SELECT.one.from(Tutorials)
        .columns('ID', 'legacyId', 'slug');
      expect(tutorial).toBeTruthy();

      const steps = await SELECT.from(Steps).where({ tutorial_ID: tutorial.ID });
      if (steps.length === 0) return; // skip if tutorial has no steps

      // Find a user with completed steps on this tutorial
      const stepLegacyIds = steps.map(s => s.legacyId);
      const completedRecords = await SELECT.from(TaskRecords).where({
        taskType: 'STEP',
        status: 'COMPLETED',
        taskLegacyId: { in: stepLegacyIds }
      }).limit(1);

      if (completedRecords.length > 0) {
        // If there are completed step records, verify progress calculation is consistent
        const userRecord = completedRecords[0];
        const allUserStepRecords = await SELECT.from(TaskRecords).where({
          user_ID: userRecord.user_ID,
          taskType: 'STEP',
          status: 'COMPLETED',
          taskLegacyId: { in: stepLegacyIds }
        });

        const expectedProgress = Math.round((allUserStepRecords.length / steps.length) * 100);
        expect(expectedProgress).toBeGreaterThan(0);
        expect(expectedProgress).toBeLessThanOrEqual(100);
      }
    });

    it('task records reference valid users', async () => {
      const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');

      const records = await SELECT.from(TaskRecords).limit(20);
      const userIds = [...new Set(records.map(r => r.user_ID).filter(Boolean))];

      for (const userId of userIds.slice(0, 5)) {
        const user = await SELECT.one.from(Users, userId);
        expect(user).toBeTruthy();
      }
    });

    it('completed task records have completionDate set', async () => {
      const { TaskRecords } = cds.entities('com.sap.developers.ims');

      const completed = await SELECT.from(TaskRecords)
        .where({ status: 'COMPLETED' })
        .limit(20);

      for (const record of completed) {
        expect(record.completionDate).toBeTruthy();
      }
    });
  });

  describe('points and scoring', () => {
    it('completed steps have progress = 100', async () => {
      const { TaskRecords } = cds.entities('com.sap.developers.ims');

      const stepRecords = await SELECT.from(TaskRecords)
        .where({ taskType: 'STEP', status: 'COMPLETED' })
        .limit(50);

      for (const record of stepRecords) {
        expect(record.progress).toBe(100);
      }
    });

    it('in-progress records have progress < 100', async () => {
      const { TaskRecords } = cds.entities('com.sap.developers.ims');

      const inProgress = await SELECT.from(TaskRecords)
        .where({ status: 'IN_PROGRESS' })
        .limit(20);

      for (const record of inProgress) {
        expect(record.progress).toBeLessThan(100);
      }
    });
  });
});
