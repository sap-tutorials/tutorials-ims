import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('Full integration workflow', () => {

  beforeAll(async () => {
    const { Tutorials, Steps, Users } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries({
      ID: 'aaaaaaaa-flow-0000-0000-000000000001',
      slug: 'flow-tutorial', title: 'Flow Tutorial',
      legacyId: 9001, status: 'ACTIVE'
    });

    await INSERT.into(Steps).entries([
      { ID: 'bbbbbbbb-flow-0001-0000-000000000001', tutorial_ID: 'aaaaaaaa-flow-0000-0000-000000000001', stepOrder: 1, title: 'Step 1', legacyId: 9101 },
      { ID: 'bbbbbbbb-flow-0002-0000-000000000001', tutorial_ID: 'aaaaaaaa-flow-0000-0000-000000000001', stepOrder: 2, title: 'Step 2', legacyId: 9102 },
    ]);

    await INSERT.into(Users).entries({
      ID: 'cccccccc-flow-0000-0000-000000000001',
      uuid: 'developer', legacyId: 9201, sapId: 'S0099'
    });
  });

  it('developer completes a step and NGDS message is queued', async () => {
    // Complete step via DeveloperService
    const { status } = await project.post('/api/completeStep',
      { slug: 'flow-tutorial', stepNumber: 1 },
      { auth: { username: 'developer', password: 'developer' } });
    expect(status).toBe(200);

    // Verify step completion created a task record
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const stepRecord = await SELECT.one.from(TaskRecords).where({
      taskLegacyId: 9101, taskType: 'STEP', status: 'COMPLETED'
    });
    expect(stepRecord).toBeTruthy();

    // Admin sends to NGDS (will fail without real destination, storing for retry)
    if (stepRecord) {
      const { status: ngdsStatus } = await project.post('/admin/sendToNgds',
        { taskRecordLegacyId: stepRecord.legacyId },
        { auth: { username: 'admin', password: 'admin' } });
      expect(ngdsStatus).toBe(200);

      // Verify failed message was stored
      const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
      const failed = await SELECT.from(NGDSFailedMessages);
      expect(failed.length).toBeGreaterThan(0);
    }
  });

  it('consolidation service merges accounts end-to-end', async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    // Create secondary user with records
    await INSERT.into(Users).entries({
      ID: 'dddddddd-flow-0000-0000-000000000001',
      uuid: 'secondary-flow', legacyId: 9301
    });
    await INSERT.into(TaskRecords).entries({
      ID: 'eeeeeeee-flow-0000-0000-000000000001',
      user_ID: 'dddddddd-flow-0000-0000-000000000001',
      taskLegacyId: 9001, taskType: 'TUTORIAL', status: 'COMPLETED', legacyId: 9401
    });

    // Merge via ConsolidationService
    const { status } = await project.post('/api/v1/userMerge',
      { primaryUuid: 'developer', secondaryUuid: 'secondary-flow' },
      { auth: { username: 'admin', password: 'admin' } });
    expect(status).toBe(204);

    // Verify records transferred to primary
    const records = await SELECT.from(TaskRecords)
      .where({ user_ID: 'cccccccc-flow-0000-0000-000000000001' });
    const hasMergedRecord = records.some(r => r.legacyId === 9401);
    expect(hasMergedRecord).toBe(true);
  });
});
