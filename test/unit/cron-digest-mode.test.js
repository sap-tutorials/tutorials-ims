// test/unit/cron-digest-mode.test.js
//
// Task 10 (#622) — weekly contributor-notifications cron branches on
// knobs.useDigest. Exercises the extracted runContributorNotificationsCycle
// function with mocked helpers to verify both the digest and legacy paths.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the modules used by the cron body.
vi.mock('../../srv/lib/contributor-notifications.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveTimingKnobs: vi.fn(),
    computeStaleNotifications: vi.fn(),
    getAdminEmailList: vi.fn(),
    isNotificationsEnabled: vi.fn(),
    markNotificationSent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../srv/lib/mail-client.js', () => ({
  sendNotificationEmail: vi.fn(),
  retryFailedEmails: vi.fn(),
}));

vi.mock('../../srv/lib/runtime-config/display-settings.js', () => ({
  resolveDisplaySettings: vi.fn().mockResolvedValue({ dashboardUrl: 'https://dash' }),
}));

vi.mock('../../srv/lib/pipeline-log.js', () => ({
  logPipelineStart: vi.fn().mockResolvedValue('test-log-id'),
  logPipelineEnd: vi.fn().mockResolvedValue(undefined),
  logPipeline: vi.fn(),
  logPipelineItem: vi.fn().mockResolvedValue(undefined),
  logJobItem: vi.fn().mockResolvedValue(undefined),
}));

const {
  resolveTimingKnobs, computeStaleNotifications, getAdminEmailList,
  isNotificationsEnabled, markNotificationSent
} = await import('../../srv/lib/contributor-notifications.js');
const { sendNotificationEmail } = await import('../../srv/lib/mail-client.js');
const { runContributorNotificationsCycle } = await import('../../srv/jobs/scheduler.js');

const stubKnobs = (extra = {}) => ({
  staleDays: 90, resendIntervalDays: 30, maxLevel: 3,
  useDigest: true, lastChanceMinLevel: 3, lastChanceDormancyDays: 60,
  ...extra,
});

const stubNotifications = () => [
  { tutorialId: 't1', slug: 't1', title: 'T1', reviewedDate: '2025-01-01T00:00:00.000Z',
    notificationLevel: 0, lastNotificationDate: null,
    contributors: [], repoOwner: null,
    authorUserEmail: 'alice@sap.com', authorUserName: 'Alice' },
  { tutorialId: 't2', slug: 't2', title: 'T2', reviewedDate: '2025-01-01T00:00:00.000Z',
    notificationLevel: 1, lastNotificationDate: null,
    contributors: [], repoOwner: null,
    authorUserEmail: 'alice@sap.com', authorUserName: 'Alice' },
  { tutorialId: 't3', slug: 't3', title: 'T3', reviewedDate: '2025-01-01T00:00:00.000Z',
    notificationLevel: 0, lastNotificationDate: null,
    contributors: [], repoOwner: null,
    authorUserEmail: 'bob@sap.com', authorUserName: 'Bob' },
];

describe('runContributorNotificationsCycle — digest mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNotificationsEnabled.mockResolvedValue(true);
    getAdminEmailList.mockResolvedValue(['admin@sap.com']);
    sendNotificationEmail.mockResolvedValue({ success: true });
  });

  it('useDigest=true: 3 tutorials/2 authors → 2 sends, 3 markNotificationSent', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs());
    computeStaleNotifications.mockResolvedValue(stubNotifications());

    await runContributorNotificationsCycle('test-log-id');

    expect(sendNotificationEmail).toHaveBeenCalledTimes(2);
    expect(markNotificationSent).toHaveBeenCalledTimes(3);
    const firstCall = sendNotificationEmail.mock.calls[0][0];
    expect(firstCall).toHaveProperty('template');
    expect(firstCall.template).toMatch(/^digest-level-/);
    expect(firstCall.variables).toHaveProperty('tutorialListHtml');
  });

  it('useDigest=false: 3 tutorials → 3 sends with level (no template)', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs({ useDigest: false }));
    computeStaleNotifications.mockResolvedValue(stubNotifications().map(n => ({
      ...n, contributors: [{ name: 'X', email: n.authorUserEmail, role: 'OWNER' }],
    })));

    await runContributorNotificationsCycle('test-log-id');

    expect(sendNotificationEmail).toHaveBeenCalledTimes(3);
    expect(markNotificationSent).toHaveBeenCalledTimes(3);
    const firstCall = sendNotificationEmail.mock.calls[0][0];
    expect(firstCall).toHaveProperty('level');
    expect(firstCall).not.toHaveProperty('template');
  });

  it('digest send failure → zero markNotificationSent for that digest, others process normally', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs());
    computeStaleNotifications.mockResolvedValue(stubNotifications());
    // First send (alice) fails; second (bob) succeeds.
    sendNotificationEmail
      .mockResolvedValueOnce({ success: false, error: 'smtp down' })
      .mockResolvedValueOnce({ success: true });

    await runContributorNotificationsCycle('test-log-id');

    // Only bob's single tutorial (t3) got marked. Alice's 2 (t1, t2) did NOT.
    expect(markNotificationSent).toHaveBeenCalledTimes(1);
    expect(markNotificationSent).toHaveBeenCalledWith('t3');
  });

  it('notifications disabled → returns enabled:false, no sends', async () => {
    isNotificationsEnabled.mockResolvedValue(false);
    const result = await runContributorNotificationsCycle('test-log-id');
    expect(result).toEqual({ enabled: false });
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('digest with no resolvable author → SKIPPED, no send', async () => {
    resolveTimingKnobs.mockResolvedValue(stubKnobs());
    computeStaleNotifications.mockResolvedValue([{
      tutorialId: 't1', slug: 't1', title: 'T', reviewedDate: '2025-01-01',
      notificationLevel: 0, lastNotificationDate: null,
      contributors: [], repoOwner: null,
      authorUserEmail: null, authorUserName: null,
    }]);

    await runContributorNotificationsCycle('test-log-id');

    expect(sendNotificationEmail).not.toHaveBeenCalled();
    expect(markNotificationSent).not.toHaveBeenCalled();
  });
});
