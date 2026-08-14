// e2e: public What's New page smoke (#task-6).
// Path: browser → approuter /whats-new/ → Hugo-served static page.
// No auth — the page is publicly accessible.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: What\'s New page', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('renders the hero title and weekly digest or empty state', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/whats-new/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /whats-new/`).toBe(200);
      // Wait for the hero title to appear and verify its text.
      await page.locator('h1.wn-hero__title').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('h1.wn-hero__title').count()).toBeGreaterThan(0);
      const titleText = await page.locator('h1.wn-hero__title').first().textContent();
      expect(titleText, 'hero title should contain "What"').toMatch(/What/i);
      // Either week sections or the empty-state must be present.
      const sectionCount = await page.locator('.wn-week, .wn-empty').count();
      expect(sectionCount, 'expected .wn-week or .wn-empty to be present').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
