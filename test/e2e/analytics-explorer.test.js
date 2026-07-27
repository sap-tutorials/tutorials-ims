// e2e: authenticated analytics-explorer load (#1338).
// Path: browser → approuter /analytics-ui/ (XSUAA) → Vue 3 SPA → CAP /admin/analytics.
// Asserts the SPA mounts (a top-level heading renders). Monaco is lazy-loaded
// and deliberately NOT asserted on — its bundle download alone would blow the
// test budget.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: analytics-explorer (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('analytics-explorer SPA mounts and renders its shell', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/analytics-ui/', { waitUntil: 'domcontentloaded' });
      // Vue mount proof: a top-level heading OR the app root becomes visible.
      // Loose selector union so a class rename in the SPA doesn't break the test.
      await page
        .locator('h1, [role="heading"], #app, main, .app')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      expect(await page.locator('h1, [role="heading"], #app, main, .app').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
