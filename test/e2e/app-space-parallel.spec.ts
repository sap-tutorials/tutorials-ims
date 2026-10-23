// e2e: App Space parallel-paths fork detail view (#2887).
//
// Loads the /app-space/ page (anonymous) and, when a fork track is present in
// the API response, asserts:
//   1. The track detail view renders at least two `.lane` columns inside `.lanes`.
//   2. Each lane has a visible `.lane__name` label.
//   3. At least one item in the fork carries a lock (`.step--locked`) — proving
//      the downstream checkpoint is gated until the lane is complete.
//
// The fork-track data is seeded on DEV via the admin UI or rebuild workflow.
// If no event has a fork-track configured on the target env, the spec treats
// that as a valid empty state (same pattern as topic-clusters-band.spec.ts)
// and exits without failing — so fresh/staging deploys without seed data are
// never penalised.
//
// Self-skips without PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL (repo e2e convention,
// #1338). The unit tier (`npm test`) is unaffected.
//
// Run post-deploy:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/app-space-parallel.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: App Space parallel-paths fork detail view (#2887)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('app-space page loads and shows the hero + track grid', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/app-space/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response!.status(), 'unexpected status for /app-space/').toBe(200);

      // The Vue island mounts into #app-space. Wait for the hero title (always
      // present even when there are no tracks).
      await page.locator('.app-space').waitFor({ state: 'attached', timeout: 20_000 });
      // Hero title or skeleton must be in the DOM once the island hydrates.
      const heroVisible = await page.locator('.hero-title, .hero-title-skeleton').count();
      expect(heroVisible, 'hero should render after island hydration').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('a fork track renders two lane columns + a locked downstream item', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/app-space/', { waitUntil: 'domcontentloaded' });

      // Wait for the island to settle (loading spinner disappears, grid appears
      // OR empty-state appears).
      await page.locator('.track-grid, .empty-state, .track-card').waitFor({
        state: 'attached',
        timeout: 25_000,
      }).catch(() => {/* island may not have a track-grid when there are 0 tracks */});

      // Find a track card whose track has segments (fork shape).  We detect
      // this by clicking cards one by one and looking for `.lanes` in the detail
      // view.  If no fork track is configured on this env, exit gracefully.
      const trackCards = await page.locator('.track-card').all();
      if (trackCards.length === 0) {
        // No tracks configured on this env — valid empty state, not a failure.
        return;
      }

      let foundForkTrack = false;
      for (const card of trackCards) {
        await card.click();
        // Wait briefly for the detail view to settle.
        await page.locator('.timeline, .detail-header').waitFor({
          state: 'attached',
          timeout: 10_000,
        }).catch(() => {});

        const lanesCount = await page.locator('.lanes').count();
        if (lanesCount > 0) {
          foundForkTrack = true;
          break;
        }

        // Not a fork track — go back and try the next card.
        await page.locator('.back-button').click();
        await page.locator('.track-grid').waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
      }

      if (!foundForkTrack) {
        // No fork track seeded on this env — valid, not a failure.
        return;
      }

      // ── Assert fork layout ────────────────────────────────────────────────
      // At least two lane columns must be present (the fork has ≥2 branches).
      const laneCount = await page.locator('.lanes .lane').count();
      expect(laneCount, 'fork segment must have at least two lane columns').toBeGreaterThanOrEqual(2);

      // Each lane must have a visible label.
      const laneNames = page.locator('.lane__name');
      expect(
        await laneNames.count(),
        'each lane must have a .lane__name label'
      ).toBeGreaterThanOrEqual(2);
      // The first label is non-empty text.
      const firstName = await laneNames.first().textContent();
      expect(firstName?.trim().length, 'lane label must be non-empty').toBeGreaterThan(0);

      // A locked downstream item must exist — proves the join-checkpoint is not
      // unlocked until a lane completes (the anonymous viewer has no completions).
      const lockedCount = await page.locator('.step--locked').count();
      expect(lockedCount, 'at least one item should be locked for an anonymous visitor').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
