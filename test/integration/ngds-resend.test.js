// test/integration/ngds-resend.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { selectResendCandidates, resendMissingTracking } from '../../scripts/lib/ngds-resend.mjs';

const test = cds.test('serve', '--project', '.', '--in-memory');
const EPOCH = new Date('2026-07-01T00:00:00Z').getTime();

describe('ngds-resend candidate selection + gates', () => {
  beforeAll(async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: 'us000001-0000-0000-0000-000000000001', uuid: 'P0005555001', legacyId: 6001, sapId: 'P0005555001' }, // canonical
      { ID: 'us000002-0000-0000-0000-000000000002', uuid: 'devuser', legacyId: 6002, sapId: 'devuser' },          // non-canonical
    ]);
    await INSERT.into(TaskRecords).entries([
      // eligible: completed tutorial, canonical user, after epoch, has id
      { ID: 'rs000001-0000-0000-0000-000000000001', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6101, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6101, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6101' },
      // ineligible: migration-stamped
      { ID: 'rs000002-0000-0000-0000-000000000002', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6102, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6102, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6102', createdBy: 'migration' },
      // ineligible: pre-epoch
      { ID: 'rs000003-0000-0000-0000-000000000003', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6103, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6103, completionDate: '2026-06-01T00:00:00Z', submissionIdCompleted: 'trk-6103' },
      // ineligible: non-canonical sapId
      { ID: 'rs000004-0000-0000-0000-000000000004', user_ID: 'us000002-0000-0000-0000-000000000002', taskLegacyId: 6104, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 6104, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6104' },
      // ineligible: wrong task type
      { ID: 'rs000005-0000-0000-0000-000000000005', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6105, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 6105, completionDate: '2026-08-01T00:00:00Z', submissionIdCompleted: 'trk-6105' },
      // ineligible: not completed
      { ID: 'rs000006-0000-0000-0000-000000000006', user_ID: 'us000001-0000-0000-0000-000000000001', taskLegacyId: 6106, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 20, legacyId: 6106, completionDate: null, submissionIdStarted: 'trk-6106' },
    ]);
  });

  it('selects only the eligible record given the epoch gate', async () => {
    const db = await cds.connect.to('db');
    const candidates = await selectResendCandidates(db, { epochMs: EPOCH });
    expect(candidates.map(c => c.taskLegacyId)).toEqual([6101]);
  });

  it('dry-run resend sends nothing and reports the total', async () => {
    const db = await cds.connect.to('db');
    const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
    const before = (await SELECT.from(NGDSFailedMessages)).length;
    const r = await resendMissingTracking(db, { dryRun: true, epochMs: EPOCH });
    expect(r.total).toBe(1);
    expect(r.sent).toBe(0);
    expect((await SELECT.from(NGDSFailedMessages)).length).toBe(before); // no send attempted
  });
});
