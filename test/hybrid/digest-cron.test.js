/**
 * #622 Task 14 — Hybrid test: digest cron against real HANA.
 *
 * Seeds 3 tutorials for one synthetic author and a DormantAuthors view row,
 * then exercises runContributorNotificationsCycle (Task 10's extracted cron
 * body) against real HANA. Asserts:
 *   - Exactly ONE digest email is queued for the synthetic author
 *     (not 3 per-tutorial emails).
 *   - The selected template is the digest variant (digest-level-N).
 *   - The tutorialCount variable matches the seeded count (3).
 *
 * Plus a regression guard for the DormantAuthors view from Task 13.
 *
 * Hybrid-safety: the cron's computeStaleNotifications() naturally enumerates
 * EVERY stale tutorial in DEV. If we let the unmocked cron run, it would
 * advance the notificationNumber on every dormant author in shared DEV — a
 * destructive side-effect we can't leave behind even with afterAll cleanup
 * (we don't track the IDs we'd have to roll back). So we stub
 * computeStaleNotifications() to return ONLY the rows for our seeded author.
 * The DB writes the cycle performs (markNotificationSent) then affect ONLY
 * our seeded TutorialMeta rows, which afterAll deletes wholesale.
 *
 * The following still execute against real HANA:
 *   - cds.test 'serve' against profile=hybrid (HDI binding via cds bind)
 *   - INSERT/SELECT/DELETE of seeded Users/Tutorials/TutorialMeta/ImsConfig
 *   - isNotificationsEnabled() + resolveTimingKnobs() (real ImsConfig reads)
 *   - markNotificationSent() during the success path (real TutorialMeta UPDATE)
 *   - The DormantAuthors view (real CDS view compiled to HANA)
 *
 * Mocking note: scheduler.js statically imports sendNotificationEmail from
 * mail-client.js (Task 10's refactor). The hybrid test imports the scheduler
 * directly (NOT via cds.serve), so vi.mock can intercept the static import.
 * Same applies to computeStaleNotifications from contributor-notifications.js.
 *
 * Uses TEST_PREFIX = '__TEST_622__' to isolate from other hybrid tests and
 * production data. Cleanup runs in afterAll and is idempotent.
 *
 * Run with:
 *   ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/digest-cron.test.js
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Cold-start of `cds.test serve` against real HANA can exceed Vitest's
// default 10s hook timeout, especially when this is the only test file in
// the run. Bump both.
vi.setConfig({ hookTimeout: 180000, testTimeout: 120000 });

// Captured outbound messages — the mocked sendNotificationEmail pushes here.
const sentMessages = [];

// vi.mock is hoisted, so this intercepts the static imports in scheduler.js
// before the dynamic import of '../../srv/jobs/scheduler.js' is resolved.
vi.mock('../../srv/lib/mail-client.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    sendNotificationEmail: async (opts) => {
      sentMessages.push(opts);
      return { success: true };
    },
    retryFailedEmails: async () => ({ retried: 0, succeeded: 0 }),
  };
});

// Stub computeStaleNotifications to return ONLY our seeded rows. See header
// comment for rationale (avoids destructive sweep of shared DEV's dormant
// authors). All OTHER helpers — including markNotificationSent, which writes
// to HANA — pass through to the real implementations.
//
// Scope caveat: this stub bypasses the cutoff/staleness/MAX_NOTIFICATION_LEVEL
// filtering that the real computeStaleNotifications performs. A future
// regression that moves a level-cap or eligibility filter OUT of the helper
// and INTO the cron-runner (runContributorNotificationsCycle / runDigestCycle)
// would not be caught here — the stub feeds the cron whatever shape the test
// chose. Add a separate unit test if such a filter is introduced.
let stubNotifications = [];
vi.mock('../../srv/lib/contributor-notifications.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    computeStaleNotifications: async () => stubNotifications,
  };
});

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST_622__';
const RUN_ID = `${TEST_PREFIX}${Date.now()}`;
const TEST_EMAIL = `${RUN_ID}-alice@example.com`;

const created = {
  users: [],
  tutorials: [],
  meta: [],
  imsConfig: [],
};

describe.runIf(isSafeForWrites())('Digest cron against real HANA (#622)', () => {
  beforeAll(async () => {
    const { Tutorials, TutorialMeta, Users, ImsConfig } =
      cds.entities('com.sap.developers.ims');
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    const db = await cds.connect.to('db');

    // Seed synthetic author. Users uses `cuid` so ID is normally server-
    // assigned; pass an explicit UUID up front to skip the SELECT round-trip.
    const userLegacyId = await getNextLegacyId('Users', db);
    const userId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: userId,
      uuid: `${RUN_ID}-uuid`,
      email: TEST_EMAIL,
      firstName: TEST_PREFIX,
      lastName: 'Alice',
      displayName: `${TEST_PREFIX} Alice`,
      legacyId: userLegacyId,
    });
    created.users.push(userId);

    // Seed 3 stale tutorials owned by that author. reviewedDate is 200 days
    // in the past so they trip the 90-day staleness threshold.
    // notificationNumber starts at 1 → digest template = digest-level-1.
    const oldDate = new Date(Date.now() - 200 * 86400000).toISOString();
    for (let i = 1; i <= 3; i++) {
      const tutorialLegacyId = await getNextLegacyId('Tutorials', db);
      const tutorialId = cds.utils.uuid();
      const slug = `${RUN_ID}-slug-${i}`;
      await INSERT.into(Tutorials).entries({
        ID: tutorialId,
        slug,
        title: `${TEST_PREFIX} Tutorial ${i}`,
        status: 'ACTIVE',
        author_ID: userId,
        legacyId: tutorialLegacyId,
      });
      created.tutorials.push(tutorialId);

      const metaLegacyId = await getNextLegacyId('TutorialMeta', db);
      const metaId = cds.utils.uuid();
      await INSERT.into(TutorialMeta).entries({
        ID: metaId,
        tutorial_ID: tutorialId,
        monitoredStatus: 'ACTIVE',
        reviewedDate: oldDate,
        notificationNumber: 1,
        lastNotificationDate: null,
        legacyId: metaLegacyId,
      });
      created.meta.push(metaId);
    }

    // Force the relevant knobs ON in real ImsConfig: digest mode + sending.
    for (const [key, value] of [
      ['useDigestNotifications', 'true'],
      ['isNotificationSendingAllowed', 'true'],
    ]) {
      const existing = await SELECT.one.from(ImsConfig).where({ key });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value });
        created.imsConfig.push({ ID: existing.ID, originalValue: existing.value, key });
      } else {
        const id = cds.utils.uuid();
        await INSERT.into(ImsConfig).entries({ ID: id, key, value });
        created.imsConfig.push({ ID: id, originalValue: null, key, inserted: true });
      }
    }

    // Build the stubNotifications array now that we know the seeded IDs.
    // Shape matches what computeStaleNotifications returns (see
    // srv/lib/contributor-notifications.js).
    stubNotifications = created.tutorials.map((tutorialId, idx) => ({
      tutorialId,
      slug: `${RUN_ID}-slug-${idx + 1}`,
      title: `${TEST_PREFIX} Tutorial ${idx + 1}`,
      reviewedDate: oldDate,
      notificationLevel: 1,
      lastNotificationDate: null,
      contributors: [],
      repoOwner: null,
      authorUserEmail: TEST_EMAIL,
      authorUserName: `${TEST_PREFIX} Alice`,
    }));
  });

  afterAll(async () => {
    const { Tutorials, TutorialMeta, Users, ImsConfig } =
      cds.entities('com.sap.developers.ims');

    // Reverse FK order: TutorialMeta → Tutorials → Users.
    for (const id of created.meta) {
      try { await DELETE.from(TutorialMeta).where({ ID: id }); } catch { /* idempotent */ }
    }
    for (const id of created.tutorials) {
      try { await DELETE.from(Tutorials).where({ ID: id }); } catch { /* idempotent */ }
    }
    for (const id of created.users) {
      try { await DELETE.from(Users).where({ ID: id }); } catch { /* idempotent */ }
    }
    // Restore (or delete) ImsConfig rows we touched.
    for (const cfg of created.imsConfig) {
      try {
        if (cfg.inserted) {
          await DELETE.from(ImsConfig).where({ ID: cfg.ID });
        } else {
          await UPDATE(ImsConfig, cfg.ID).set({ value: cfg.originalValue });
        }
      } catch { /* idempotent */ }
    }
  });

  it('3 tutorials for one author → exactly 1 digest queued', async () => {
    const { runContributorNotificationsCycle } =
      await import('../../srv/jobs/scheduler.js');

    sentMessages.length = 0;
    await runContributorNotificationsCycle(`${RUN_ID}-cycle-log`);

    // computeStaleNotifications is stubbed to return only our 3 rows, so
    // exactly one message must be in the captured array.
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    // resolveAuthor() lowercases authorEmail when grouping; assert case-
    // insensitive containment so the test doesn't trip on HANA NVARCHAR's
    // case-preserving storage of mixed-case test emails.
    expect(msg.to.map(e => String(e).toLowerCase()))
      .toContain(TEST_EMAIL.toLowerCase());
    expect(msg.template).toMatch(/^digest-level-/);
    expect(msg.variables?.tutorialCount).toBe(3);
    // Sanity: rendered HTML should mention all 3 seeded slugs.
    expect(msg.variables?.tutorialListHtml).toContain(`${RUN_ID}-slug-1`);
    expect(msg.variables?.tutorialListHtml).toContain(`${RUN_ID}-slug-2`);
    expect(msg.variables?.tutorialListHtml).toContain(`${RUN_ID}-slug-3`);
  });

  // Regression guard for the DormantAuthors view (Task 13). The view is
  // defined in db/views.cds (Task 13 commit c6f7f5ab) but not yet deployed
  // to DEV — Task 16 ships `cds build --production` + HDI deploy. Until
  // then this test is `it.skip` so the assertion is unambiguously inert
  // (no silent soft-skip masking a real failure). After Task 16 lands,
  // flip to `it` and it becomes a hard-fail regression guard.
  it.skip('DormantAuthors view exposes the seeded author with tutorialCount=3 (un-skip after Task 16 deploy)', async () => {
    const { DormantAuthors } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(DormantAuthors).where({ authorEmail: TEST_EMAIL });
    expect(rows).toHaveLength(1);
    expect(rows[0].tutorialCount).toBe(3);
  });
});
