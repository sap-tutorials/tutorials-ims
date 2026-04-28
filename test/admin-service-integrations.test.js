import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService integrations', () => {

  beforeAll(async () => {
    const { Tutorials, TutorialMeta, TutorialContributors, TaskRecords, Users } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-intg-0000-0000-000000000001',
      uuid: 'intg-user', legacyId: 4001, sapId: 'S001'
    });

    await INSERT.into(Tutorials).entries({
      ID: 'bbbbbbbb-intg-0000-0000-000000000001',
      slug: 'intg-tutorial', title: 'Integration Tutorial',
      legacyId: 4101, status: 'ACTIVE'
    });

    await INSERT.into(TaskRecords).entries({
      ID: 'cccccccc-intg-0000-0000-000000000001',
      user_ID: 'aaaaaaaa-intg-0000-0000-000000000001',
      taskLegacyId: 4101, taskType: 'TUTORIAL',
      status: 'COMPLETED', legacyId: 4201
    });
  });

  describe('sendToNgds', () => {
    it('stores a failed NGDS message when destination is unavailable', async () => {
      const { status } = await project.post('/admin/sendToNgds',
        { taskRecordLegacyId: 4201 },
        { auth: { username: 'admin', password: 'admin' } });
      expect(status).toBe(200);

      const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
      const failed = await SELECT.from(NGDSFailedMessages);
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0].status).toBe('PENDING');
    });
  });

  describe('syncTutorialMetadata', () => {
    it('returns synced count (0 when no cache file exists in test env)', async () => {
      const { status, data } = await project.post('/admin/syncTutorialMetadata', {},
        { auth: { username: 'admin', password: 'admin' } });
      expect(status).toBe(200);
      expect(data.synced).toBe(0);
    });
  });

  describe('sendContributorNotifications', () => {
    it('computes notifications for stale tutorials', async () => {
      const { TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
      const staleDate = new Date(Date.now() - 200 * 86400000).toISOString();
      await INSERT.into(TutorialMeta).entries({
        ID: 'dddddddd-intg-0000-0000-000000000001',
        tutorial_ID: 'bbbbbbbb-intg-0000-0000-000000000001',
        reviewedDate: staleDate, owner: 'owner@sap.com',
        monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 4301
      });
      await INSERT.into(TutorialContributors).entries({
        ID: 'eeeeeeee-intg-0000-0000-000000000001',
        tutorial_ID: 'bbbbbbbb-intg-0000-0000-000000000001',
        name: 'Test Author', email: 'test@sap.com', role: 'AUTHOR', legacyId: 4401
      });

      const { status, data } = await project.post('/admin/sendContributorNotifications', {},
        { auth: { username: 'admin', password: 'admin' } });
      expect(status).toBe(200);
      expect(data.notified).toBeGreaterThanOrEqual(1);
    });
  });
});
