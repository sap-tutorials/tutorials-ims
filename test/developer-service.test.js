import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('DeveloperService', () => {

  describe('getProgress', () => {
    it('returns 404 for unknown slug', async () => {
      const { status } = await project.get('/api/getProgress(slug=\'nonexistent\')',
        { auth: { username: 'developer', password: 'developer' }, validateStatus: () => true });
      expect(status).toBe(404);
    });
  });

  describe('completeStep', () => {
    beforeAll(async () => {
      // Seed test data: a tutorial with 3 steps
      const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');

      await INSERT.into(Tutorials).entries({
        ID: 'aaaaaaaa-0000-0000-0000-000000000001',
        slug: 'test-tutorial',
        title: 'Test Tutorial',
        legacyId: 1001,
        status: 'ACTIVE'
      });

      await INSERT.into(Steps).entries([
        { ID: 'bbbbbbbb-0000-0000-0000-000000000001', tutorial_ID: 'aaaaaaaa-0000-0000-0000-000000000001', stepOrder: 1, title: 'Step 1', legacyId: 2001 },
        { ID: 'bbbbbbbb-0000-0000-0000-000000000002', tutorial_ID: 'aaaaaaaa-0000-0000-0000-000000000001', stepOrder: 2, title: 'Step 2', legacyId: 2002 },
        { ID: 'bbbbbbbb-0000-0000-0000-000000000003', tutorial_ID: 'aaaaaaaa-0000-0000-0000-000000000001', stepOrder: 3, title: 'Step 3', legacyId: 2003 },
      ]);
    });

    it('returns progress after completing a step', async () => {
      const { status, data } = await project.post('/api/completeStep',
        { slug: 'test-tutorial', stepNumber: 1 },
        { auth: { username: 'developer', password: 'developer' } });

      expect(status).toBe(200);
      expect(data.completedSteps).toContain(1);
      expect(data.points).toBe(10);
    });

    it('returns cumulative progress after completing second step', async () => {
      const { data } = await project.post('/api/completeStep',
        { slug: 'test-tutorial', stepNumber: 2 },
        { auth: { username: 'developer', password: 'developer' } });

      expect(data.completedSteps).toEqual([1, 2]);
      expect(data.points).toBe(20);
    });

    it('is idempotent when completing same step twice', async () => {
      await project.post('/api/completeStep',
        { slug: 'test-tutorial', stepNumber: 1 },
        { auth: { username: 'developer', password: 'developer' } });

      const { data } = await project.get('/api/getProgress(slug=\'test-tutorial\')',
        { auth: { username: 'developer', password: 'developer' } });
      expect(data.completedSteps).toEqual([1, 2]);
      expect(data.points).toBe(20);
    });
  });

  describe('createTaskRecord (legacy)', () => {
    beforeAll(async () => {
      const { Users } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Users).entries({
        ID: 'cccccccc-0000-0000-0000-000000000001',
        uuid: 'developer',
        legacyId: 5001
      });
    });

    it('creates a task record by legacyId', async () => {
      const { status, data } = await project.post('/api/createTaskRecord',
        { taskLegacyId: 1001, taskType: 'TUTORIAL', eventLegacyId: null },
        { auth: { username: 'developer', password: 'developer' } });

      expect(status).toBe(200);
      expect(data.taskLegacyId).toBe(1001);
      expect(data.status).toBe('COMPLETED');
    });
  });

  describe('accomplishment evaluation', () => {
    beforeAll(async () => {
      const { Accomplishments } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Accomplishments).entries({
        ID: 'test-acc-1',
        legacyId: 99901,
        name: 'First Tutorial',
        rule: "SELECT CASE WHEN COUNT(*) >= 1 THEN 100 ELSE 0 END as score FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID = ? AND STATUS = 'COMPLETED' AND TASKTYPE = 'TUTORIAL'",
        description: 'Complete your first tutorial'
      });
    });

    it('awards accomplishment when rule passes after task completion', async () => {
      const { AccomplishmentRecords, Users } = cds.entities('com.sap.developers.ims');

      const res = await project.post('/api/createTaskRecord',
        { taskLegacyId: 10001, taskType: 'TUTORIAL' },
        { auth: { username: 'developer', password: 'developer' } });
      expect(res.status).toBe(200);

      const user = await SELECT.one.from(Users).where({ uuid: 'developer' });
      const records = await SELECT.from(AccomplishmentRecords).where({ user_ID: user.ID });
      expect(records.some(r => r.accomplishment_ID === 'test-acc-1')).toBe(true);
    });

    it('does not double-award accomplishments', async () => {
      const res = await project.post('/api/createTaskRecord',
        { taskLegacyId: 10002, taskType: 'TUTORIAL' },
        { auth: { username: 'developer', password: 'developer' } });
      expect(res.status).toBe(200);

      const { AccomplishmentRecords, Users } = cds.entities('com.sap.developers.ims');
      const user = await SELECT.one.from(Users).where({ uuid: 'developer' });
      const records = await SELECT.from(AccomplishmentRecords).where({
        user_ID: user.ID,
        accomplishment_ID: 'test-acc-1'
      });
      expect(records.length).toBe(1);
    });
  });
});
