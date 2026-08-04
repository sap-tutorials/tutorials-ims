import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// End-to-end proof that a completion fires the PROD-only auto-send. We force
// the two gates open: VCAP space=prod (env gate) + ImsConfig flag on. With no
// reachable NGDS destination the send is queued in NGDSFailedMessages — the
// same PENDING-row signal used by the other NGDS integration tests. The
// negative case (gates closed) asserts NO send is attempted.

const project = cds.test('serve', '--project', '.', '--in-memory');

const ORIGINAL_VCAP = process.env.VCAP_APPLICATION;

async function setAutoSendFlag(enabled) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.enabled' });
  if (existing) await UPDATE(ImsConfig, existing.ID).set({ value: String(enabled) });
  else await INSERT.into(ImsConfig).entries({ key: 'ngds.autosend.enabled', value: String(enabled) });
  // Bust the helper's 60s flag cache between phases.
  const { resetAutoSendFlagCache } = await import('../../srv/lib/ngds-autosend.js');
  resetAutoSendFlagCache();
}

async function countFailed() {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(NGDSFailedMessages);
  return rows.length;
}

describe('NGDS auto-send on completion (PROD-only)', () => {
  beforeAll(async () => {
    const { Users, Missions, Groups } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-auto-0000-0000-000000000001',
      // Basic-auth tests resolve the user via user.id (the mock username), so
      // sapId must equal the login name — see resolve-db-user.js fallback chain.
      uuid: 'developer', legacyId: 7001, sapId: 'developer'
    });
    await INSERT.into(Groups).entries({
      ID: 'cccccccc-auto-0000-0000-000000000001',
      slug: 'auto-group', title: 'Auto Group', legacyId: 7100, status: 'ACTIVE'
    });
    await INSERT.into(Missions).entries({
      ID: 'bbbbbbbb-auto-0000-0000-000000000001',
      slug: 'auto-mission', title: 'Auto Mission', legacyId: 7101,
      status: 'ACTIVE', communityMissionId: 'comm-7101'
    });
  });

  afterAll(async () => {
    if (ORIGINAL_VCAP === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = ORIGINAL_VCAP;
    await setAutoSendFlag(false);
  });

  it('does NOT auto-send when the env gate is closed (non-prod space)', async () => {
    process.env.VCAP_APPLICATION = JSON.stringify({ space_name: 'dev' });
    await setAutoSendFlag(true);
    const before = await countFailed();

    // GROUP completion in a non-prod space — must not attempt a send.
    const { status } = await project.post('/api/createTaskRecord',
      { taskLegacyId: 7100, taskType: 'GROUP' },
      { auth: { username: 'developer', password: 'developer' } });
    expect(status).toBe(200);

    expect(await countFailed()).toBe(before); // no send attempted → no queued row
  });

  it('auto-sends a MISSION completion when PROD + flag on (queued: no destination)', async () => {
    process.env.VCAP_APPLICATION = JSON.stringify({ space_name: 'prod' });
    await setAutoSendFlag(true);
    const before = await countFailed();

    // Fresh (user, task) pair → createTaskRecord takes the INSERT branch and
    // fires the edge → COMPLETED auto-send.
    const { status } = await project.post('/api/createTaskRecord',
      { taskLegacyId: 7101, taskType: 'MISSION' },
      { auth: { username: 'developer', password: 'developer' } });
    expect(status).toBe(200);

    // Send was attempted; with no NGDS destination it lands in the retry queue.
    expect(await countFailed()).toBeGreaterThan(before);
  });
});
