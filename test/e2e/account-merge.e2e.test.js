// e2e: /me/merge account history merge page (post-deploy smoke).
// Path: browser → approuter /me/merge → baked static page + account-merge island.
//
// The page is served as a static file (authenticationType: none on the catch-all
// route), so the 200 + mount-point assertion runs without credentials. The
// island itself gates its form on isSignedIn() — the email input and send button
// are only rendered when SMOKE_TECH_USER + SMOKE_TECH_PASSWORD are supplied and
// the Basic auth header is accepted by the approuter's /auth/user endpoint.
//
// This spec deliberately DOES NOT attempt the confirm flow — that path requires
// a seeded AccountMergeRequest token and is exercised in hybrid-HANA tests, not
// post-deploy smoke.
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so
// `npm test` (unit tier) and credential-less local runs stay green.
//
// Run against a deployed approuter:
//   SMOKE_BASE_URL=https://… SMOKE_TECH_USER=… SMOKE_TECH_PASSWORD=… \
//     npx vitest run --project e2e test/e2e/account-merge.e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /me/merge account history merge page', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('/me/merge renders <main> and the #account-merge island mount', async () => {
    // The static page is accessible without auth — the island handles its own
    // login-gate rendering via isSignedIn(). The mount point must always be
    // present in the baked HTML so the Vue island has a hydration target.
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/me/merge', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /me/merge`).toBe(200);

      // The /me/merge page uses the standard baseof.html template (type: me),
      // which emits a <main> landmark — NOT <article> (verified repo fact).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(
        await page.locator('main').count(),
        '/me/merge must render a <main> element'
      ).toBeGreaterThan(0);

      // The island mount div must be present in the static HTML; its presence
      // confirms the Hugo template included the account-merge island at build time.
      expect(
        await page.locator('#account-merge').count(),
        '/me/merge must render a #account-merge mount div'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('request form (email input + send button) renders when signed in', async () => {
    // This assertion requires SMOKE_TECH_USER + SMOKE_TECH_PASSWORD. Without
    // credentials the island shows only the "please sign in" message — skip
    // rather than fail so the spec stays tolerant in credential-less CI jobs.
    if (!hasCredentials()) return;

    const { context, page } = await newPage(browser, { authenticated: true });
    try {
      await page.goto('/me/merge', { waitUntil: 'domcontentloaded' });

      // Wait for the island to hydrate and finish its isSignedIn() fetch.
      // The email input only renders once the authenticated request state is
      // confirmed — allow up to 15s for the JS bundle to load and execute.
      await page.locator('#merge-target-email').waitFor({ state: 'visible', timeout: 15_000 });

      expect(
        await page.locator('#merge-target-email').count(),
        'request form must render the target-email input'
      ).toBeGreaterThan(0);

      expect(
        await page.locator('[data-test="send-verification-btn"]').count(),
        'request form must render the send-verification-btn'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
