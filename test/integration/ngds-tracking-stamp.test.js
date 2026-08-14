import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Proves the fix end-to-end: a completion persists a submissionId, and the NGDS
// payload the auto-send builds now carries trackingInfo.tracking. We force the
// PROD gates open with no reachable destination, so the send queues into
// NGDSFailedMessages — whose stored payload we inspect for `tracking`.
const project = cds.test('serve', '--project', '.', '--in-memory');
const ORIGINAL_VCAP = process.env.VCAP_APPLICATION;

async function setAutoSendFlag(enabled) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.enabled' });
  if (existing) await UPDATE(ImsConfig, existing.ID).set({ value: String(enabled) });
  else await INSERT.into(ImsConfig).entries({ key: 'ngds.autosend.enabled', value: String(enabled) });
  const { resetAutoSendFlagCache } = await import('../../srv/lib/ngds-autosend.js');
  resetAutoSendFlagCache();
}

describe('NGDS trackingInfo.tracking is populated on completion', () => {
  beforeAll(async () => {
    const { Users, Missions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-trk0-0000-0000-000000000001',
      uuid: 'P0007777001', legacyId: 8001, sapId: 'P0007777001',
    });
    await INSERT.into(Missions).entries({
      ID: 'bbbbbbbb-trk0-0000-0000-000000000001',
      slug: 'trk-mission', title: 'Tracking Mission', legacyId: 8101,
      status: 'ACTIVE', communityMissionId: 'comm-8101',
    });
  });

  afterAll(async () => {
    if (ORIGINAL_VCAP === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = ORIGINAL_VCAP;
    await setAutoSendFlag(false);
  });

  it('persists submissionIdCompleted and emits trackingInfo.tracking', async () => {
    process.env.VCAP_APPLICATION = JSON.stringify({ space_name: 'prod' });
    await setAutoSendFlag(true);

    const { status } = await project.post('/api/createTaskRecord',
      { taskLegacyId: 8101, taskType: 'MISSION' },
      { auth: { username: 'P0007777001', password: 'P0007777001' } });
    expect(status).toBe(200);

    // 1. Persisted row carries the stamped id.
    const { TaskRecords, NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
    const rec = await SELECT.one.from(TaskRecords).where({ taskLegacyId: 8101, taskType: 'MISSION' });
    expect(rec.submissionIdCompleted).toBeTruthy();

    // 2. The queued NGDS payload now contains trackingInfo.tracking (was missing before the fix).
    const queued = await SELECT.from(NGDSFailedMessages);
    const mine = queued.map(q => JSON.parse(q.payload)).find(p => p?.imsData?.IMSID === '8101');
    expect(mine).toBeTruthy();
    expect(mine.trackingInfo.tracking).toBe(rec.submissionIdCompleted);
  });
});
