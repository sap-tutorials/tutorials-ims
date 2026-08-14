// e2e: merged Top Tutorials carousel (#1782).
// Path: browser → approuter / (homepage anonymous) → Vue island
//       `/api/homepage/top-tutorials?window=<days>` → CAP → HANA TopTutorialsSnapshot.
// Exercises mode toggle (Featured/Top), window chips (90/180/360, default 180),
// and carousel render (card OR empty-state on fresh DB).
//
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only: npx vitest run --project e2e test/e2e/top-tutorials-carousel.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: Top Tutorials carousel (#1782)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('flips to Top Tutorials mode and switches time windows', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // Load the homepage (anonymous).
      const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /`).toBe(200);

      // Served page convention: <main> + <h1> (never <article>), #1338.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Featured Topics Carousel island is mounted and hydrated.
      const carousel = page.locator('[data-app="featured-topics-carousel"]');
      await carousel.waitFor({ state: 'attached', timeout: 20_000 });
      await expect(carousel).toBeVisible();

      // Locate the mode toggle button labeled "Top Tutorials".
      const topTutorialsButton = carousel.getByRole('button', { name: /Top Tutorials/i });
      await expect(topTutorialsButton).toBeVisible();

      // Click to flip to Top Tutorials mode.
      await topTutorialsButton.click();

      // Window chips appear; 180d is the default selection after mode flip.
      const w180 = carousel.getByRole('button', { name: '180d' });
      await expect(w180).toBeVisible();
      await expect(w180).toHaveAttribute('aria-pressed', 'true');

      // Either a top-tutorial card or the empty-state is valid on a freshly-seeded env.
      const cardOrEmpty = carousel.locator(
        '.nav-card__type--tutorial, .hp-featured-carousel__empty'
      ).first();
      await expect(cardOrEmpty).toBeVisible();

      // Switch to 90d window; both chips update their pressed state.
      const w90 = carousel.getByRole('button', { name: '90d' });
      await expect(w90).toBeVisible();
      await w90.click();

      await expect(w90).toHaveAttribute('aria-pressed', 'true');
      await expect(w180).toHaveAttribute('aria-pressed', 'false');

      // Carousel still renders (card or empty-state).
      await expect(cardOrEmpty).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
