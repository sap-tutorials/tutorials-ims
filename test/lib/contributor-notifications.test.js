import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('contributor-notifications', () => {
  let computeStaleNotifications;

  beforeAll(async () => {
    ({ computeStaleNotifications } = await import('../../srv/lib/contributor-notifications.js'));

    const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([
      { ID: 'ffffffff-0001-0000-0000-000000000001', slug: 'stale-tutorial', title: 'Stale Tutorial', legacyId: 6001, status: 'ACTIVE' },
      { ID: 'ffffffff-0002-0000-0000-000000000001', slug: 'fresh-tutorial', title: 'Fresh Tutorial', legacyId: 6002, status: 'ACTIVE' },
    ]);

    // Stale: reviewed 200 days ago
    const staleDate = new Date(Date.now() - 200 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries({
      ID: 'aaaaaaaa-meta-0001-0000-000000000001',
      tutorial_ID: 'ffffffff-0001-0000-0000-000000000001',
      reviewedDate: staleDate, owner: 'owner@sap.com',
      monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 6101
    });

    // Fresh: reviewed 10 days ago
    const freshDate = new Date(Date.now() - 10 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries({
      ID: 'aaaaaaaa-meta-0002-0000-000000000001',
      tutorial_ID: 'ffffffff-0002-0000-0000-000000000001',
      reviewedDate: freshDate, owner: 'owner@sap.com',
      monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 6102
    });

    await INSERT.into(TutorialContributors).entries([
      { ID: 'bbbbbbbb-cont-0001-0000-000000000001', tutorial_ID: 'ffffffff-0001-0000-0000-000000000001', name: 'Alice', email: 'alice@sap.com', role: 'AUTHOR', legacyId: 6201 },
      { ID: 'bbbbbbbb-cont-0002-0000-000000000001', tutorial_ID: 'ffffffff-0002-0000-0000-000000000001', name: 'Bob', email: 'bob@sap.com', role: 'AUTHOR', legacyId: 6202 },
    ]);
  });

  it('identifies stale tutorials needing notification (>90 days)', async () => {
    const notifications = await computeStaleNotifications(90);
    expect(notifications.length).toBe(1);
    expect(notifications[0].slug).toBe('stale-tutorial');
    expect(notifications[0].contributors[0].email).toBe('alice@sap.com');
  });

  it('returns empty when no tutorials are stale', async () => {
    const notifications = await computeStaleNotifications(365);
    expect(notifications.length).toBe(0);
  });

  describe('markNotificationSent firstNotificationDate tracking', () => {
    let markNotificationSent;

    beforeAll(async () => {
      ({ markNotificationSent } = await import('../../srv/lib/contributor-notifications.js'));
    });

    it('sets firstNotificationDate on the first nag (notificationNumber=0)', async () => {
      const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
      const tutorialId = 'ffffffff-fn01-0000-0000-000000000001';
      const metaId = 'aaaaaaaa-fn01-0000-0000-000000000001';

      await INSERT.into(Tutorials).entries({
        ID: tutorialId, slug: 'fn-first-nag', title: 'First Nag Test',
        legacyId: 9001, status: 'ACTIVE',
      });
      await INSERT.into(TutorialMeta).entries({
        ID: metaId, tutorial_ID: tutorialId,
        reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
        owner: 'fn@sap.com', monitoredStatus: 'ACTIVE',
        notificationNumber: 0, legacyId: 9101,
      });

      await markNotificationSent(tutorialId);

      const updated = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
      expect(updated.notificationNumber).toBe(1);
      expect(updated.firstNotificationDate).toBeTruthy();
      expect(updated.lastNotificationDate).toBeTruthy();
      // On the first nag, firstNotificationDate and lastNotificationDate are equal
      expect(updated.firstNotificationDate).toBe(updated.lastNotificationDate);
    });

    it('does NOT overwrite firstNotificationDate on subsequent nags (notificationNumber=2 → 3)', async () => {
      const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
      const tutorialId = 'ffffffff-fn02-0000-0000-000000000001';
      const metaId = 'aaaaaaaa-fn02-0000-0000-000000000001';
      const originalFirstNag = new Date(Date.now() - 90 * 86400000).toISOString();

      await INSERT.into(Tutorials).entries({
        ID: tutorialId, slug: 'fn-subsequent', title: 'Subsequent Nag Test',
        legacyId: 9002, status: 'ACTIVE',
      });
      await INSERT.into(TutorialMeta).entries({
        ID: metaId, tutorial_ID: tutorialId,
        reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
        owner: 'fn2@sap.com', monitoredStatus: 'ACTIVE',
        notificationNumber: 2,
        firstNotificationDate: originalFirstNag,
        lastNotificationDate: new Date(Date.now() - 30 * 86400000).toISOString(),
        legacyId: 9102,
      });

      await markNotificationSent(tutorialId);

      const updated = await SELECT.one.from(TutorialMeta).where({ ID: metaId });
      expect(updated.notificationNumber).toBe(3);
      // firstNotificationDate is UNCHANGED (still the 90-day-old value)
      expect(updated.firstNotificationDate).toBe(originalFirstNag);
      // lastNotificationDate IS updated to now
      expect(new Date(updated.lastNotificationDate).getTime()).toBeGreaterThan(Date.now() - 5000);
    });
  });

  describe('computeStaleNotifications filtering edge cases', () => {
    it('filters out tutorials at notificationNumber >= 4', async () => {
      const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
      const tutorialId = 'ffffffff-flt1-0000-0000-000000000001';
      const metaId = 'aaaaaaaa-flt1-0000-0000-000000000001';

      await INSERT.into(Tutorials).entries({
        ID: tutorialId, slug: 'maxed-tutorial', title: 'Maxed Out',
        legacyId: 9003, status: 'ACTIVE',
      });
      await INSERT.into(TutorialMeta).entries({
        ID: metaId, tutorial_ID: tutorialId,
        reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
        owner: 'maxed@sap.com', monitoredStatus: 'ACTIVE',
        notificationNumber: 4, legacyId: 9103,
      });
      await INSERT.into(TutorialContributors).entries({
        ID: 'bbbbbbbb-flt1-0000-0000-000000000001',
        tutorial_ID: tutorialId,
        name: 'Maxed', email: 'maxed@sap.com', role: 'AUTHOR', legacyId: 9203,
      });

      const notifications = await computeStaleNotifications(90);
      const slugs = notifications.map((n) => n.slug);
      expect(slugs).not.toContain('maxed-tutorial');
    });

    it("filters out tutorials with tutorial.status = 'INACTIVE'", async () => {
      const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
      const tutorialId = 'ffffffff-flt2-0000-0000-000000000001';
      const metaId = 'aaaaaaaa-flt2-0000-0000-000000000001';

      await INSERT.into(Tutorials).entries({
        ID: tutorialId, slug: 'inactive-tutorial', title: 'Inactive Tut',
        legacyId: 9004, status: 'INACTIVE',
      });
      await INSERT.into(TutorialMeta).entries({
        ID: metaId, tutorial_ID: tutorialId,
        reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
        owner: 'inactive@sap.com', monitoredStatus: 'ACTIVE',
        notificationNumber: 0, legacyId: 9104,
      });
      await INSERT.into(TutorialContributors).entries({
        ID: 'bbbbbbbb-flt2-0000-0000-000000000001',
        tutorial_ID: tutorialId,
        name: 'Inactive', email: 'inactive@sap.com', role: 'AUTHOR', legacyId: 9204,
      });

      const notifications = await computeStaleNotifications(90);
      const slugs = notifications.map((n) => n.slug);
      expect(slugs).not.toContain('inactive-tutorial');
    });
  });
});
