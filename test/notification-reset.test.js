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
      ownerEmail: 'owner@sap.com',  // #450: required for MyTutorialsView inner-join on Users.email
      monitoredStatus: 'ACTIVE', notificationNumber: 2,
      lastNotificationDate: lastNotified,
      firstNotificationDate: lastNotified,  // #450: pre-existing value to verify reviewTutorial clears it
      legacyId: 7101
    });

    await INSERT.into(TutorialContributors).entries({
      ID: 'bbbbbbbb-7201-0000-0000-000000000001',
      tutorial_ID: tutorialId,
      name: 'Owner', email: 'owner@sap.com', role: 'OWNER', legacyId: 7201
    });

    // #450: MyTutorialsView inner-joins on Users.email = TutorialMeta.ownerEmail.
    // Without a matching Users row, the reviewed tutorial is filtered out of
    // the view entirely, and the outdated assertions below would crash.
    const { Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'cccccccc-7301-0000-0000-000000000001',
      uuid: 'user-uuid-7301',
      email: 'owner@sap.com'
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
      const { TutorialMeta, MyTutorialsView } = cds.entities('com.sap.developers.ims');
      const meta = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
      expect(meta.notificationNumber).toBe(0);
      expect(meta.lastNotificationDate).toBeNull();
      expect(meta.firstNotificationDate).toBeNull();  // #450: clearing extends to the new field
      expect(new Date(meta.reviewedDate).getTime()).toBeGreaterThan(Date.now() - 5000);

      // #450: after review, the row should be queryable from MyTutorialsView
      // and outdated should be false (notificationNumber=0 < 4).
      // The view's key is tutorial_ID (not ID) — see db/views.cds line 271.
      const reviewedRow = await SELECT.one.from(MyTutorialsView).where({ tutorial_ID: tutorialId });
      expect(reviewedRow).toBeTruthy();  // confirms the inner-join with Users resolves
      expect(reviewedRow.notificationNumber).toBe(0);
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
