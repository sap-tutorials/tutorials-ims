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
});
