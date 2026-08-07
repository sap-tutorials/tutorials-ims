// e2e: featured tasks endpoint & shape validation (#2026-featured-tasks).
// Path: browser → approuter /build/featured → CAP endpoint → HANA FeaturedTasks.
// Read-only assertion: endpoint exists and returns the expected shape.
// Full create-flow via the admin UI value-help is added after the first DEV deploy
// when the deployed admin DOM can be verified live (per #1378 e2e pattern).
//
// Slug reused from test/a11y/urls.js ('abap-cloud-ui-from-interface', a stable
// long-lived HANA-served tutorial). If it ever 404s, swap for another slug from
// that same a11y list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: curated featured tasks (unauthenticated)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('/build/featured endpoint returns the expected shape', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/build/featured', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /build/featured`).toBe(200);

      // Extract and validate JSON shape
      const body = await page.evaluate(() => {
        const elem = document.querySelector('body');
        return elem ? JSON.parse(elem.textContent) : null;
      });

      expect(body).not.toBeNull();
      expect(body).toHaveProperty('featured');
      expect(Array.isArray(body.featured)).toBeTruthy();
      expect(body).toHaveProperty('etag');
      expect(typeof body.etag).toBe('string');
    } finally {
      await context.close();
    }
  });
});
