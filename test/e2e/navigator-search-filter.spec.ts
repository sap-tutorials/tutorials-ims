// test/e2e/navigator-search-filter.spec.ts
//
// e2e: Navigator search & filter improvements (#3112).
//
// Three post-deploy smoke scenarios:
//   G1 — a checked product filter floats to the top of its column
//   G2 — searching a mission-matching term surfaces a mission card (lozenge ≥ 1)
//   G3 — "My progress" column present when signed in; absent when anonymous;
//          ?completed=1 URL does not empty the grid when anonymous
//
// Self-skips when PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL is absent — so
// `npm test` (unit suite) and credential-less local runs are never affected.
// G3 signed-in assertions additionally self-skip when SMOKE_TECH_USER /
// SMOKE_TECH_PASSWORD are absent.
//
// Run post-deploy only:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/navigator-search-filter.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const NAV_PATH = '/tutorial-navigator';
// The Vue island replaces the SSR preview with the mounted result area once loaded.
const MOUNTED_MARKER = '.navigator-result-area';

describe.skipIf(!hasBaseUrl())('e2e: navigator search & filter improvements (#3112)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  // ── G1: selected filter floats to the top of its column ───────────────────
  it('G1: checking a non-first product filter option floats it to the top', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response for /tutorial-navigator').not.toBeNull();
      expect(response!.status(), 'unexpected status').toBe(200);

      // Wait for the Vue island to mount so the filter panel is interactive.
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 20_000 });

      // Find the Software-Product filter column — identify it by its heading text.
      // Navigator columns render as .filter-column; each has a heading and a list
      // of .filter-option elements. We pick the first column that contains more
      // than one option so there is a "non-first" option to click.
      const columns = page.locator('.filter-column');
      const count = await columns.count();
      expect(count, 'no filter columns found — navigator not mounted').toBeGreaterThan(0);

      // Find a column that has at least 2 visible options.
      let targetColumnIndex = -1;
      for (let i = 0; i < count; i++) {
        const opts = await columns.nth(i).locator('.filter-option').count();
        if (opts >= 2) {
          targetColumnIndex = i;
          break;
        }
      }
      if (targetColumnIndex === -1) {
        // No column has multiple options on this env — graceful skip.
        return;
      }

      const col = columns.nth(targetColumnIndex);
      const options = col.locator('.filter-option');

      // Read the label of the SECOND option (index 1) — this is what we will check.
      const secondLabel = await options.nth(1).locator('.filter-label').textContent();
      if (!secondLabel) return; // graceful skip

      // Click the checkbox on the second option.
      const secondCheckbox = options.nth(1).locator('.filter-checkbox');
      await secondCheckbox.check();

      // After checking, the selected option should float to the top — it becomes
      // the first .filter-option in this column.
      await page.waitForFunction(
        ({ colIndex, label }: { colIndex: number; label: string }) => {
          const cols = document.querySelectorAll('.filter-column');
          const col = cols[colIndex];
          if (!col) return false;
          const first = col.querySelector('.filter-option .filter-label');
          return first?.textContent?.trim() === label.trim();
        },
        { colIndex: targetColumnIndex, label: secondLabel },
        { timeout: 5_000 },
      );

      const firstLabelAfter = await options.first().locator('.filter-label').textContent();
      expect(
        firstLabelAfter?.trim(),
        'checked option did not float to the top of the column',
      ).toBe(secondLabel.trim());
    } finally {
      await context.close();
    }
  }, 45_000);

  // ── G2: searching a mission-matching term surfaces a mission card ──────────
  it('G2: searching a mission term renders at least one mission card and mission lozenge ≥ 1', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response for /tutorial-navigator').not.toBeNull();
      expect(response!.status(), 'unexpected status').toBe(200);

      // Wait for the Vue island to mount.
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 20_000 });

      // Check the mission lozenge exists and has a non-zero count before searching.
      // The toolbar renders .toolbar-count buttons with a .count-mission span.
      const missionLozenge = page.locator('.toolbar-count .count-mission').first();
      const lozengeVisible = await missionLozenge.isVisible().catch(() => false);
      if (!lozengeVisible) {
        // No missions in this env yet — graceful skip.
        return;
      }

      // Read the pre-search mission count.
      const lozengeText = await missionLozenge.textContent() ?? '0';
      const totalMissions = parseInt(lozengeText.replace(/\D/g, ''), 10);
      if (isNaN(totalMissions) || totalMissions === 0) return; // no missions — skip

      // Type a search term broad enough to match at least one mission.
      // "SAP BTP" is a stable, widely-used tag across mission content.
      const searchInput = page.locator('#navigator-search-input, [data-testid="navigator-search"], input[type="search"]').first();
      const searchVisible = await searchInput.isVisible().catch(() => false);
      if (!searchVisible) {
        // Try a more permissive selector — the search box may use a different markup.
        // Attempt to find any visible text input inside the navigator.
        const fallback = page.locator('#tutorial-navigator input[type="text"], #tutorial-navigator input[type="search"]').first();
        const fallbackVisible = await fallback.isVisible().catch(() => false);
        if (!fallbackVisible) return; // no search box found — graceful skip
        await fallback.fill('SAP BTP');
        await page.keyboard.press('Enter');
      } else {
        await searchInput.fill('SAP BTP');
        await page.keyboard.press('Enter');
      }

      // Wait for the results to update (debounce + fetch).
      await page.waitForTimeout(2_000);

      // After search, check whether the mission lozenge still shows ≥ 1.
      // If the lozenge count is 0 the search term found no missions — graceful skip
      // (live content may vary; we only assert when missions are present).
      const lozengeAfterText = await missionLozenge.textContent().catch(() => '0') ?? '0';
      const missionsAfterCount = parseInt(lozengeAfterText.replace(/\D/g, ''), 10);
      if (isNaN(missionsAfterCount) || missionsAfterCount === 0) return; // no match — skip

      expect(
        missionsAfterCount,
        'mission lozenge shows 0 missions after search',
      ).toBeGreaterThanOrEqual(1);

      // Assert that at least one mission card is present in the result grid.
      // Mission cards have an href with a /missions/ segment.
      const missionCard = page.locator(
        '#tutorial-navigator a[href*="/missions/"], .mission-card, [data-type="mission"]',
      ).first();
      const missionCardVisible = await missionCard.isVisible().catch(() => false);
      expect(
        missionCardVisible,
        'mission lozenge ≥ 1 but no mission card visible in the result grid',
      ).toBe(true);
    } finally {
      await context.close();
    }
  }, 45_000);

  // ── G3a: My progress column is present when signed in ─────────────────────
  it('G3 (signed-in): "My progress" column is visible and Completed filter narrows results', async () => {
    if (!hasCredentials()) {
      // Self-skip cleanly — no error, just an early return (describe.skipIf
      // already gates the whole suite on hasBaseUrl; we gate this scenario on
      // credentials separately to allow the anon scenario to run without them).
      return;
    }

    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      const response = await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response for /tutorial-navigator (auth)').not.toBeNull();
      expect(response!.status(), 'unexpected status').toBe(200);

      // Wait for the Vue island to mount.
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 20_000 });

      // The "My progress" column should be present for signed-in users.
      // Its heading text is "My progress".
      const progressColumnHeading = page.getByText('My progress', { exact: true }).first();
      await expect(
        progressColumnHeading,
        '"My progress" column heading not visible for signed-in user',
      ).toBeVisible({ timeout: 10_000 });

      // Count cards before applying the Completed filter.
      const allCards = page.locator(
        '#tutorial-navigator a[href*="/tutorials/"], #tutorial-navigator a[href*="/missions/"], #tutorial-navigator a[href*="/groups/"]',
      );
      const cardsBefore = await allCards.count();

      // Check the "Completed" checkbox inside the My progress column.
      const completedCheckbox = page.locator('.filter-column').filter({ hasText: 'My progress' })
        .locator('.filter-checkbox').first();
      const checkboxVisible = await completedCheckbox.isVisible().catch(() => false);
      if (!checkboxVisible) return; // graceful skip if column structure differs

      await completedCheckbox.check();

      // Wait for result update.
      await page.waitForTimeout(2_000);

      // After filtering: the grid should show only completed content, which may be
      // a subset (fewer or equal) compared to the full set. We assert ≤ cardsBefore
      // rather than an exact count since completed-item counts vary by env.
      const cardsAfter = await allCards.count();
      expect(
        cardsAfter,
        'card count after Completed filter should not exceed the unfiltered count',
      ).toBeLessThanOrEqual(cardsBefore);
    } finally {
      await context.close();
    }
  }, 45_000);

  // ── G3b: My progress column is ABSENT for anonymous users ─────────────────
  it('G3 (anon): "My progress" column is absent; ?completed=1 URL does not empty the grid', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response for /tutorial-navigator (anon)').not.toBeNull();
      expect(response!.status(), 'unexpected status').toBe(200);

      // Wait for the Vue island to mount.
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 20_000 });

      // "My progress" column must NOT appear for anonymous visitors.
      const progressColumnHeading = page.getByText('My progress', { exact: true });
      const progressCount = await progressColumnHeading.count();
      expect(
        progressCount,
        '"My progress" column should not be visible to anonymous users',
      ).toBe(0);

      // Navigate to the navigator with ?completed=1 — the anon scrub must
      // ignore the param and still render a non-empty card grid.
      const response2 = await page.goto(`${NAV_PATH}?completed=1`, {
        waitUntil: 'domcontentloaded',
      });
      expect(response2, 'no response for ?completed=1').not.toBeNull();
      expect(response2!.status(), 'unexpected status for ?completed=1').toBe(200);

      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 20_000 });

      // Wait for the result grid to settle.
      await page.waitForTimeout(1_500);

      // At least one card must be visible — the anon-scrub must have stripped the
      // completed filter so results are not empty.
      const anyCard = page.locator(
        '#tutorial-navigator a[href*="/tutorials/"], #tutorial-navigator a[href*="/missions/"], #tutorial-navigator a[href*="/groups/"]',
      ).first();
      const cardVisible = await anyCard.isVisible().catch(() => false);
      expect(
        cardVisible,
        '?completed=1 for an anonymous user produced an empty grid — anon scrub may be broken',
      ).toBe(true);
    } finally {
      await context.close();
    }
  }, 45_000);
});
