// e2e: Devtoberfest animated arcade gameboard. Anonymous demo state.
// Path: browser → approuter /devtoberfest/arcade/ (static) → /js/arcade.js
//       → island fetch /gameboard/getMyGameboard (→ gameboard-srv; 401 anon)
//       → fail-soft to the animated demo board + "Join Devtoberfest" CTA.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest arcade (anonymous demo)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the animated demo board (cabinet + demo avatar) and the join CTA', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/arcade/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> + <h1> (never <article>).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island hydrates the arcade scene: CRT cabinet frame + a demo avatar.
      await page.locator('.scene .s-frame').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.s-avatar').count(), 'demo avatar should render').toBeGreaterThan(0);

      // Anonymous → the register CTA overlay.
      expect(await page.getByText(/Join Devtoberfest/i).count(), 'join CTA should render').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
