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

  it('renders the per-provider sign-in buttons with correct sap_idp hrefs', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/signin', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response!.status(), 'unexpected status for /signin').toBe(200);

      // Each button deep-links to one IAS corporate IdP via the approuter's
      // dynamicIdentityProvider (sap_idp → &idp=<Name> on the XSUAA authorize
      // URL → IAS routes straight to that provider). Google/X are IAS social
      // tiles (not idp-addressable) and live behind the "More options" pass-through.
      const buttons: Array<[string, string]> = [
        ['Continue with GitHub', '/login?sap_idp=sap.custom,GitHub'],
        ['Continue with Google', '/login?sap_idp=sap.custom,Google'],
        ['Continue with Hugging Face', '/login?sap_idp=sap.custom,Hugging%20Face'],
        ['Continue with LinkedIn', '/login?sap_idp=sap.custom,LinkedIn'],
        ['Continue with SAP ID', '/login?sap_idp=sap.default'],
      ];
      for (const [name, href] of buttons) {
        const link = page.getByRole('link', { name, exact: true });
        await expect(link, `button "${name}" not visible`).toBeVisible();
        await expect(link, `button "${name}" href`).toHaveAttribute('href', href);
      }
    } finally {
      await context.close();
    }
  });
});
