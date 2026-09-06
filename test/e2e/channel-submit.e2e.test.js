// e2e: channel-submit island mount nudge (P4 submissions).
// Path: browser → approuter /channels → baked static page + channel-submit island mount.
// No auth required to verify the island mount point is present in the HTML; the
// form rendering behind the login gate is a separate concern.
//
// TOLERANT by design: this is a post-deploy nudge, not a hard gate. The only
// assertion is that the island mount element exists in the DOM — it does not
// require any particular form state, login flow, or network call to succeed.
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so
// `npm test` (unit tier) and credential-less local runs stay green.
//
// Run against a deployed approuter:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/channel-submit.e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: channel submit form (post-deploy nudge)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('/channels renders the channel-submit island mount point', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/channels/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /channels/`).toBe(200);
      // Verified repo fact: served pages render <main>, NOT <article>.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      // The submit island mount must be present in the baked HTML — this element
      // is the hydration target for the channel-submit Vue island. Its presence
      // confirms the island was included in the Hugo template at build time.
      const mountCount = await page.locator('[data-island="channel-submit"]').count();
      expect(
        mountCount,
        '/channels must render a [data-island="channel-submit"] mount point'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
