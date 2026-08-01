// e2e: public "Selfie with an Advocate" Vue island. Anonymous.
// Path: browser → approuter /devtoberfest/selfie/ (static) → /js/selfie.js
//       → island renders the advocate frame picker + uploader.
//       (No real photo upload here — that's the manual post-deploy verification;
//        this spec only asserts the island hydrates the picker + uploader.)
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest selfie (anonymous)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the frame picker and the uploader', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/selfie/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> (never <article>).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island hydrates the advocate frame picker — one thumbnail per frame.
      await page.locator('.frame-thumb').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.frame-thumb').count(), 'frame picker should render thumbnails').toBeGreaterThan(0);

      // Uploader file input hydrates (disabled until a frame is picked — presence is enough here).
      expect(await page.locator('input[type="file"]').count(), 'uploader file input should render').toBeGreaterThan(0);

      // "Not stored" privacy messaging is visible (parity with the legacy tool).
      expect(await page.getByText(/not stored/i).count(), 'privacy note should be visible').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
