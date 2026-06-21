import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { reviewTutorial, snoozeTutorial } from '../../../srv/lib/tutorial-review.js';

describe('tutorial-review module', () => {
  beforeAll(async () => {
    const dbDir = path.join(process.cwd(), 'db');
    await cds.deploy(dbDir).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries({ ID: 't-rev', slug: 'rev', title: 'R', status: 'ACTIVE' });
    await INSERT.into(TutorialMeta).entries({
      ID: 'm-rev', tutorial_ID: 't-rev', owner: 'X',
      reviewedDate: '2020-01-01T00:00:00Z',
      notificationNumber: 5,
      lastNotificationDate: '2024-01-01T00:00:00Z',
      firstNotificationDate: '2024-01-01T00:00:00Z'
    });
  });

  it('reviewTutorial resets reviewedDate and ALL notification counters', async () => {
    const result = await reviewTutorial('t-rev');
    expect(result.notificationNumber).toBe(0);
    expect(result.reviewedDate).toBeDefined();
    expect(new Date(result.reviewedDate).getTime()).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));

    // #450: verify ALL 4 review-state fields cleared in the persisted row
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    const persisted = await SELECT.one.from(TutorialMeta).where({ ID: 'm-rev' });
    expect(persisted.notificationNumber).toBe(0);
    expect(persisted.lastNotificationDate).toBeNull();
    expect(persisted.firstNotificationDate).toBeNull();
  });

  it('reviewTutorial throws when meta not found', async () => {
    await expect(reviewTutorial('does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('snoozeTutorial sets notificationDate days into the future', async () => {
    const result = await snoozeTutorial('t-rev', 7);
    const delta = Date.parse(result.notificationDate) - Date.now();
    expect(delta).toBeGreaterThan(6.5 * 86400000);
    expect(delta).toBeLessThan(7.5 * 86400000);
  });
});
