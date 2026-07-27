// e2e: unauthenticated tutorial content-serve (#1338).
// Path: browser → approuter /tutorials/:slug → CAP /content/tutorials/:slug → HANA BLOB.
// No auth — the simplest spec, proves the harness + approuter→CAP→HANA path.
//
// Slug reused from test/a11y/urls.js ('abap-cloud-ui-from-interface', a stable
// long-lived HANA-served tutorial). If it ever 404s, swap for another slug from
// that same a11y list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'abap-cloud-ui-from-interface';

describe.skipIf(!hasBaseUrl())('e2e: tutorial serve (unauthenticated)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('an anonymous visitor loads a published tutorial as HTML', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /tutorials/${SLUG}`).toBe(200);
      // playwright-core has no web-first expect (that's @playwright/test); wait
      // via the locator API, then assert the resolved count with vitest expect.
      // Verified against DEV: served tutorials render <main> + <h1> (no <article>).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('main').count()).toBeGreaterThan(0);
      expect(await page.locator('h1').count(), 'tutorial should render a heading').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
