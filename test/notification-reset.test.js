import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('Notification reset on review', () => {
  const tutorialId = 'ffffffff-7001-0000-0000-000000000001';
  const metaId = 'aaaaaaaa-7101-0000-0000-000000000001';

  beforeAll(async () => {
    const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'escalated-tutorial', title: 'Escalated Tutorial',
      legacyId: 7001, status: 'ACTIVE'
    });

    // Tutorial already at notification level 2, last notified 40 days ago
    const staleDate = new Date(Date.now() - 200 * 86400000).toISOString();
    const lastNotified = new Date(Date.now() - 40 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries({
      ID: metaId, tutorial_ID: tutorialId,
      reviewedDate: staleDate, owner: 'owner@sap.com',
      monitoredStatus: 'ACTIVE', notificationNumber: 2,
      lastNotificationDate: lastNotified, legacyId: 7101
    });

    await INSERT.into(TutorialContributors).entries({
      ID: 'bbbbbbbb-7201-0000-0000-000000000001',
      tutorial_ID: tutorialId,
      name: 'Owner', email: 'owner@sap.com', role: 'OWNER', legacyId: 7201
    });
  });

  describe('reviewTutorial action', () => {
    it('resets notificationNumber to 0 and clears lastNotificationDate', async () => {
      const { status, data } = await project.post('/admin/reviewTutorial',
        { tutorialId },
        { auth: { username: 'admin', password: 'admin' } });

      expect(status).toBe(200);
      expect(data.notificationNumber).toBe(0);
      expect(data.reviewedDate).toBeTruthy();

      // Verify persisted state
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      const meta = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
      expect(meta.notificationNumber).toBe(0);
      expect(meta.lastNotificationDate).toBeNull();
      expect(new Date(meta.reviewedDate).getTime()).toBeGreaterThan(Date.now() - 5000);
    });

    it('rejects unknown tutorial ID', async () => {
      try {
        await project.post('/admin/reviewTutorial',
          { tutorialId: 'ffffffff-0000-0000-0000-doesnotexist' },
          { auth: { username: 'admin', password: 'admin' } });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.message).toContain('404');
      }
    });

    it('reviewed tutorial no longer appears in stale notifications', async () => {
      const { computeStaleNotifications } = await import('../srv/lib/contributor-notifications.js');
      const notifications = await computeStaleNotifications(180);
      const found = notifications.find(n => n.tutorialId === tutorialId);
      expect(found).toBeUndefined();
    });
  });

  describe('snoozeTutorial action', () => {
    it('pushes lastNotificationDate into the future without resetting level', async () => {
      // First escalate back to level 1 for this test
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');
      await UPDATE(TutorialMeta, metaId).set({
        notificationNumber: 1,
        reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
        lastNotificationDate: new Date(Date.now() - 40 * 86400000).toISOString()
      });

      const { status, data } = await project.post('/admin/snoozeTutorial',
        { tutorialId, days: 60 },
        { auth: { username: 'admin', password: 'admin' } });

      expect(status).toBe(200);
      expect(data.notificationNumber).toBe(1); // preserved

      const meta = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
      const snoozeDate = new Date(meta.lastNotificationDate);
      // Should be ~60 days in the future
      expect(snoozeDate.getTime()).toBeGreaterThan(Date.now() + 55 * 86400000);
    });

    it('snoozed tutorial does not appear in stale notifications', async () => {
      const { computeStaleNotifications } = await import('../srv/lib/contributor-notifications.js');
      const notifications = await computeStaleNotifications(180);
      const found = notifications.find(n => n.tutorialId === tutorialId);
      expect(found).toBeUndefined();
    });
  });

  // Note: the `before('UPDATE', 'TutorialMeta')` handler in admin-service.js
  // is defensive code. There is no production entry point that triggers it:
  // TutorialMeta is a composition child of draft-enabled Tutorials, so
  // direct OData PATCH on the active entity is rejected by CAP, and the
  // `reviewTutorial` / `snoozeTutorial` actions (covered above) update
  // notification fields explicitly without relying on the hook.
});
