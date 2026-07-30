// test/e2e/puzzle-solve.test.js
// Post-deploy smoke: anonymous visitor loads the seeded puzzle page and the
// Vue solver island renders a grid.
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent — `npm test`
// (unit tier) is always unaffected.
// Run manually: SMOKE_BASE_URL=https://... npx vitest --project e2e run test/e2e/puzzle-solve.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'devtoberfest-cryptic-crossword';

describe.skipIf(!hasBaseUrl())('e2e: puzzle solver page (unauthenticated)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('anonymous visitor loads the puzzle page and island renders a grid', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto(`/puzzles/${SLUG}`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(
        response.status(),
        `unexpected status ${response.status()} for /puzzles/${SLUG}`,
      ).toBe(200);

      // The Vue island mounts into <main id="puzzle-mount">.
      // Verify the mount element is present in the DOM.
      await page.locator('#puzzle-mount').waitFor({ state: 'attached', timeout: 10_000 });
      expect(await page.locator('#puzzle-mount').count()).toBeGreaterThan(0);

      // The island renders a CSS-grid container with class "puzzle-grid" once
      // it fetches the layout from /api/puzzles. Wait up to 15s for the fetch.
      // Verified against App.vue: the grid wrapper emits class="puzzle-grid".
      await page.locator('.puzzle-grid').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(
        await page.locator('.puzzle-grid').count(),
        'island should render a puzzle grid',
      ).toBeGreaterThan(0);

      // Shared site shellbar confirms the Hugo shell is intact.
      // header.html: <ui5-shellbar id="app-shellbar" ...>
      expect(await page.locator('#app-shellbar').count(), 'shellbar should be present').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
