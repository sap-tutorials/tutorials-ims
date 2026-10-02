// test/e2e/signin.spec.ts
//
// e2e: IAS social-login sign-in page at /signin (#2506).
//
// Post-deploy smoke: verifies both IdP-pinned sign-in buttons render with the
// correct href attributes so the approuter's dynamicIdentityProvider routing
// fires correctly for each provider.
//
// Self-skips when PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL is absent (repo e2e
// convention, #1338) — `npm test` (unit suite) is unaffected.
//
// Run post-deploy only:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/signin.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /signin page (IAS social login, #2506)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('renders both IdP-pinned sign-in buttons with correct hrefs', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/signin', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response!.status(), 'unexpected status for /signin').toBe(200);

      const sapBtn = page.getByRole('link', { name: 'Sign in with SAP Account', exact: true });
      const uidBtn = page.getByRole('link', { name: "Sign In if you don't already have an SAP Account", exact: true });

      await expect(sapBtn).toBeVisible();
      await expect(uidBtn).toBeVisible();
      await expect(sapBtn).toHaveAttribute('href', '/login?sap_idp=sap.default');
      await expect(uidBtn).toHaveAttribute('href', '/login?sap_idp=sap.custom');
    } finally {
      await context.close();
    }
  });
});
