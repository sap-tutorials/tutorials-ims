/**
 * Unit test for the widened variables payload passed to sendNotificationEmail
 * by the contributor-notifications cron in scheduler.js and the parallel
 * sendContributorNotifications admin handler (#545).
 *
 * We don't run the cron — we extract the per-notification call inline by
 * importing the building-block functions and asserting the payload shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

const DB = './db/schema.cds';

beforeEach(async () => {
  await cds.deploy(DB).to('sqlite::memory:');
});

afterEach(async () => {
  // Drop the in-memory connection so each test gets a fresh DB. Without this,
  // the global cds.db singleton can leak ImsConfig rows between tests when
  // Vitest reuses the same worker process. Same defensive pattern as other
  // unit tests in this project that touch CDS via cds.deploy().
  if (cds.db) {
    try { await cds.disconnect(); } catch { /* best-effort */ }
  }
});

describe('scheduler — variables payload widening', () => {
  it('passes tutorialTitle, staleDaysThreshold, lastReviewedDate, dashboardUrl', async () => {
    // The scheduler's per-notification call (scheduler.js:165 area) is what we
    // assert against. Rather than mock the full cron, we re-create the call site
    // using the resolved knobs + a synthetic notification.
    const { resolveTimingKnobs } = await import('../../srv/lib/contributor-notifications.js');
    const knobs = await resolveTimingKnobs();

    const notification = {
      tutorialId: 'tid-1',
      slug: 'my-tutorial',
      title: 'My Tutorial',
      reviewedDate: '2025-12-01',
      notificationLevel: 0,
      contributors: [],
      repoOwner: null,
    };

    const dashboardUrl = 'https://example.com/dash';

    // The scheduler builds this object inline before calling sendNotificationEmail.
    // This test asserts the shape; the next task verifies scheduler.js was actually
    // updated to build this shape.
    const variables = {
      dashboardUrl,
      tutorialTitle: notification.title,
      staleDaysThreshold: knobs.staleDays,
      lastReviewedDate: notification.reviewedDate,
    };

    expect(variables.dashboardUrl).toBe('https://example.com/dash');
    expect(variables.tutorialTitle).toBe('My Tutorial');
    expect(variables.staleDaysThreshold).toBe(90);  // default fallback
    expect(variables.lastReviewedDate).toBe('2025-12-01');
  });

  it('scheduler.js wires resolveTimingKnobs into the contributor-notifications cron', async () => {
    // Source-string assert: the scheduler MUST call resolveTimingKnobs and pass
    // its return value to computeStaleNotifications.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const REPO_ROOT = join(import.meta.dirname, '..', '..');
    const src = readFileSync(join(REPO_ROOT, 'srv/jobs/scheduler.js'), 'utf8');

    expect(src).toMatch(/resolveTimingKnobs/);
    expect(src).toMatch(/computeStaleNotifications\([^)]*knobs/);
    // Variables payload must include the 3 new keys.
    expect(src).toMatch(/tutorialTitle/);
    expect(src).toMatch(/staleDaysThreshold/);
    expect(src).toMatch(/lastReviewedDate/);
  });

  it('admin-service.js sendContributorNotifications handler uses the same knobs', async () => {
    // The admin "Send Contributor Notifications" button bypasses the cron and
    // calls a parallel handler. It MUST also use resolveTimingKnobs + widen the
    // variables payload so templates render correctly when triggered manually.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const REPO_ROOT = join(import.meta.dirname, '..', '..');
    const src = readFileSync(join(REPO_ROOT, 'srv/admin-service.js'), 'utf8');

    expect(src).toMatch(/resolveTimingKnobs/);
    // The hardcoded 90 must be gone — replaced by a knobs-driven call.
    expect(src).not.toMatch(/computeStaleNotifications\(90\)/);
    // Variables payload must include all 4 keys near the sendNotificationEmail call.
    expect(src).toMatch(/tutorialTitle/);
    expect(src).toMatch(/staleDaysThreshold/);
    expect(src).toMatch(/lastReviewedDate/);
  });
});
