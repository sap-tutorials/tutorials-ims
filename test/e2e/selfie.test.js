// e2e: public "Selfie with an Advocate" Vue island. Anonymous, fully client-side.
// Path: browser → approuter /devtoberfest/selfie/ (static) → /js/selfie.js
//       → island renders the advocate frame picker; picking one reveals capture.
//       (No real background-removal model here — that's manual post-deploy QA;
//        this spec asserts the island hydrates the picker + capture affordance.)
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest selfie (anonymous)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the frame picker and reveals capture after a frame is picked', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/selfie/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island hydrates the advocate frame picker.
      await page.locator('.frame-thumb').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.frame-thumb').count()).toBeGreaterThan(0);

      // Privacy messaging: photo never leaves the browser.
      expect(await page.getByText(/never leaves your browser/i).count()).toBeGreaterThan(0);

      // Picking a frame reveals a capture affordance (camera button or upload fallback).
      await page.locator('.frame-thumb').first().click();
      const hasCapture = await page.locator('[data-testid="snap"], input[type="file"]').first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
      expect(hasCapture, 'capture control should appear after picking a frame').toBe(true);
    } finally {
      await context.close();
    }
  });
});
