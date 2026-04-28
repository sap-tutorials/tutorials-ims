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

  it('identifies stale tutorials needing notification (>180 days)', async () => {
    const notifications = await computeStaleNotifications(180);
    expect(notifications.length).toBe(1);
    expect(notifications[0].slug).toBe('stale-tutorial');
    expect(notifications[0].contributors[0].email).toBe('alice@sap.com');
  });

  it('returns empty when no tutorials are stale', async () => {
    const notifications = await computeStaleNotifications(365);
    expect(notifications.length).toBe(0);
  });
});
