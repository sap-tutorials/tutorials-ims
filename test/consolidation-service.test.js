import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('ConsolidationService', () => {

  beforeAll(async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Users).entries([
      { ID: '11111111-aaaa-0000-0000-000000000001', uuid: 'consolidation-primary', legacyId: 7001 },
      { ID: '22222222-bbbb-0000-0000-000000000001', uuid: 'consolidation-secondary', legacyId: 7002 },
    ]);

    await INSERT.into(TaskRecords).entries([
      { ID: '33333333-cccc-0000-0000-000000000001', user_ID: '22222222-bbbb-0000-0000-000000000001', taskLegacyId: 300, taskType: 'TUTORIAL', status: 'COMPLETED', legacyId: 7101 },
    ]);
  });

  it('rejects unauthenticated requests', async () => {
    const { status } = await project.post('/api/v1/userMerge',
      { primaryUuid: 'a', secondaryUuid: 'b' },
      { validateStatus: () => true });
    expect([401, 403]).toContain(status);
  });

  it('merges secondary into primary', async () => {
    const { status } = await project.post('/api/v1/userMerge',
      { primaryUuid: 'consolidation-primary', secondaryUuid: 'consolidation-secondary' },
      { auth: { username: 'admin', password: 'admin' } });
    expect(status).toBe(204);

    // Verify task records moved
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const records = await SELECT.from(TaskRecords)
      .where({ user_ID: '11111111-aaaa-0000-0000-000000000001' });
    expect(records.length).toBe(1);
  });

  it('returns merge status', async () => {
    const { status, data } = await project.get(
      "/api/v1/getMergeStatus(uuid='consolidation-primary')",
      { auth: { username: 'admin', password: 'admin' } });
    expect(status).toBe(200);
    expect(data.primaryUuid).toBe('consolidation-primary');
    expect(data.secondaryCount).toBe(1);
  });
});
