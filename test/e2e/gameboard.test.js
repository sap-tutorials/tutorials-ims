// e2e: public Devtoberfest gameboard (Plan C). Anonymous.
// Path: browser → approuter /devtoberfest/gameboard/ (static) → /js/gameboard.js
//       → island fetch /gameboard/getLeaderboard + /gameboard/getGameboard (→ gameboard-srv)
//       → realtime via existing /ws/event-stream.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest gameboard (anonymous)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the board, cabinet, and a populated leaderboard', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/gameboard/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> + <h1> (never <article>).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('h1').count(), 'gameboard should render a heading').toBeGreaterThan(0);

      // Island hydrates the arcade cabinet region.
      await page.locator('.cabinet').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.cabinet').count()).toBeGreaterThan(0);

      // Leaderboard table hydrates; either populated rows OR a visible empty-state
      // (a fresh event legitimately has zero scores — both are a valid render).
      await page.locator('table').first().waitFor({ state: 'visible', timeout: 15_000 });
      const rowCount = await page.locator('tbody tr').count();
      const hasEmpty = await page.getByText(/no scores yet/i).count();
      expect(rowCount > 0 || hasEmpty > 0, 'leaderboard should show rows or an empty state').toBe(true);
    } finally {
      await context.close();
    }
  });

  it('respects prefers-reduced-motion (no cabinet glow animation)', async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.goto('/devtoberfest/gameboard/', { waitUntil: 'domcontentloaded' });
      await page.locator('.cabinet-screen').first().waitFor({ state: 'visible', timeout: 15_000 });
      // The ::after glow animation must be 'none' under reduced motion.
      const anim = await page.locator('.cabinet-screen').first().evaluate(
        (el) => getComputedStyle(el, '::after').animationName,
      );
      expect(anim === 'none' || anim === '' || anim == null, `glow animation should be off, got ${anim}`).toBe(true);
    } finally {
      await context.close();
    }
  });
});
