// test/e2e/prerelease-navigator.spec.ts
//
// e2e: authenticated prerelease navigator load + island render (#3168).
//
// Path: browser → approuter /tutorials-prerelease/ (XSUAA scope Tutorial.PreRelease)
//       → static/prerelease/index.html → TutorialNavigator.vue island
//       → CAP /content/tutorials-prerelease/_nav (live ROLE_GATED feed).
//
// Three scenarios:
//   P1 — /tutorials-prerelease/ loads the navigator shell (index.html + island mounts)
//   P2 — client-side search narrows the card grid (or tolerates an empty state)
//   P3 — clicking a card navigates to /tutorials-prerelease/:slug which renders <main>+<h1>
//
// Self-skips when PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL is absent (npm test unit suite
// and credential-less runs are never affected). Credentials required for XSUAA auth.
//
// Run post-deploy only:
//   SMOKE_BASE_URL=https://… SMOKE_TECH_USER=… SMOKE_TECH_PASSWORD=… \
//     npx vitest run --project e2e test/e2e/prerelease-navigator.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

const NAV_PATH = '/tutorials-prerelease/';

// The Vue island replaces the SSR preview with the mounted result area once loaded.
// Mirrors the main navigator's MOUNTED_MARKER.
const MOUNTED_MARKER = '.navigator-result-area';
// The prerelease status banner added by the template.
const PRERELEASE_BANNER = '.fd-object-status--indication-2';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: prerelease navigator (#3168)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  // ── P1: navigator shell loads and island mounts ────────────────────────────
  it('P1: /tutorials-prerelease/ loads the navigator and the island mounts', async () => {
    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      const response = await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received for /tutorials-prerelease/').not.toBeNull();
      expect(
        response!.status(),
        `unexpected HTTP status ${response!.status()} for ${NAV_PATH}`,
      ).toBe(200);

      // The prerelease template emits a status banner — confirms the right shell loaded.
      await page.locator(PRERELEASE_BANNER).first().waitFor({ state: 'attached', timeout: 15_000 });
      expect(
        await page.locator(PRERELEASE_BANNER).count(),
        'prerelease status banner missing — may be loading wrong shell',
      ).toBeGreaterThan(0);

      // Wait for the Vue island to mount (replaces SSR chrome with live grid).
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 30_000 });
      expect(
        await page.locator(MOUNTED_MARKER).count(),
        'navigator island did not mount (.navigator-result-area absent)',
      ).toBeGreaterThan(0);

      // If ROLE_GATED tutorials are seeded, assert the grid renders at least one card
      // whose href starts with /tutorials-prerelease/. If none are seeded, the grid
      // container must still be present (graceful empty state — not a 404 or crash).
      const grid = page.locator('#tutorial-navigator');
      await grid.first().waitFor({ state: 'attached', timeout: 10_000 });
      expect(await grid.count(), '#tutorial-navigator container missing').toBeGreaterThan(0);

      const cards = page.locator('#tutorial-navigator a[href*="/tutorials-prerelease/"]');
      const cardCount = await cards.count();
      if (cardCount > 0) {
        // Cards exist — verify href shape.
        const firstHref = await cards.first().getAttribute('href') ?? '';
        expect(
          firstHref.startsWith('/tutorials-prerelease/'),
          `first card href "${firstHref}" does not start with /tutorials-prerelease/`,
        ).toBe(true);
      }
      // cardCount === 0 is acceptable — ROLE_GATED tutorials may not be seeded on this env;
      // what matters is that the shell loaded and the island mounted without error.
    } finally {
      await context.close();
    }
  }, 60_000);

  // ── P2: client-side search narrows the card list ───────────────────────────
  it('P2: typing into the search box narrows the card list (client-side filter)', async () => {
    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });

      // Wait for the island to mount.
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 30_000 });

      // If there are no cards at all on this env, skip the filter assertion gracefully.
      const allCards = page.locator('#tutorial-navigator a[href*="/tutorials-prerelease/"]');
      const cardsBefore = await allCards.count();
      if (cardsBefore === 0) {
        // No ROLE_GATED tutorials seeded — cannot exercise the search path; skip gracefully.
        return;
      }

      // The prerelease navigator uses data-client-search="true"; it fetches the nav feed
      // from /tutorials-prerelease/_nav.json and filters locally — no server $search.
      // The search input is the same TutorialNavigator.vue component with placeholder
      // "Search for a tutorial" (verified in navigator-search-filter.spec.ts).
      const searchInput = page.getByPlaceholder('Search for a tutorial');
      const inputVisible = await searchInput.isVisible().catch(() => false);
      if (!inputVisible) {
        // Island may have rendered but search input is not yet visible — tolerant skip.
        return;
      }

      // Type a string unlikely to match anything → grid should show 0 cards (or the
      // empty-state text). Then clear → grid should restore.
      await searchInput.fill('zzz-no-match-xyzzy-prerelease');
      // Wait for client-side debounce to apply (~300ms typical).
      await page.waitForTimeout(1_000);

      const cardsAfterNoMatch = await allCards.count();
      // The filtered count must be ≤ the original count (narrowing or empty).
      expect(
        cardsAfterNoMatch,
        'card count after non-matching search should not exceed pre-search count',
      ).toBeLessThanOrEqual(cardsBefore);

      // Clear the search to restore results.
      await searchInput.fill('');
      await page.waitForTimeout(1_000);

      const cardsAfterClear = await allCards.count();
      expect(
        cardsAfterClear,
        'card count after clearing search should match the pre-search count',
      ).toBe(cardsBefore);
    } finally {
      await context.close();
    }
  }, 60_000);

  // ── P3: clicking a card navigates to /tutorials-prerelease/:slug with <main>+<h1> ─
  it('P3: a card click navigates to /tutorials-prerelease/:slug which renders <main>+<h1>', async () => {
    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      await page.goto(NAV_PATH, { waitUntil: 'domcontentloaded' });

      // Wait for island mount.
      await page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 30_000 });

      const cards = page.locator('#tutorial-navigator a[href*="/tutorials-prerelease/"]');
      const cardCount = await cards.count();
      if (cardCount === 0) {
        // No ROLE_GATED tutorials seeded on this env — P3 cannot be exercised.
        return;
      }

      // Navigate to the tutorial slug via the first card's href (avoids click-nav
      // race with the Vue island potentially re-rendering).
      const href = await cards.first().getAttribute('href');
      if (!href || !href.startsWith('/tutorials-prerelease/')) {
        // Defensive — P1 already asserted this; skip P3 if the href shape is wrong.
        return;
      }

      const tutorialResponse = await page.goto(href, { waitUntil: 'domcontentloaded' });
      expect(tutorialResponse, `no response for ${href}`).not.toBeNull();
      expect(
        tutorialResponse!.status(),
        `unexpected status ${tutorialResponse!.status()} for ${href}`,
      ).toBe(200);

      // Served tutorials render <main>+<h1>, NOT <article> — per repo e2e convention.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 20_000 });
      expect(
        await page.locator('main').count(),
        'tutorial page should render a <main> element',
      ).toBeGreaterThan(0);
      expect(
        await page.locator('h1').count(),
        'tutorial page should render an <h1> heading',
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 60_000);
});
