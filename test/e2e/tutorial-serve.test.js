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

  // Regression guard for #1890: the "Submit detailed feedback" button lazy-loads
  // the tutorial-feedback island via feedback-share.html. A double-quote bug
  // (`| jsonify` in a <script> JS context) produced a src with embedded quote
  // chars → /tutorials/%22/js/…%22 404 → island never mounted → EMPTY popup.
  // This asserts the island script loads (no 404) and the form actually renders.
  it('the "Submit detailed feedback" popup mounts the feedback form', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const islandFailures = [];
      page.on('response', (r) => {
        const u = r.url();
        if (u.includes('tutorial-feedback') && u.endsWith('.js') && r.status() >= 400) {
          islandFailures.push(`${r.status()} ${u}`);
        }
      });

      await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      const btn = page.locator('ui5-button:has-text("Submit detailed feedback")').first();
      await btn.waitFor({ state: 'visible', timeout: 15_000 });
      await btn.click();

      // The detailed form has a row unique to it (the inline rating widget does
      // not) — its presence proves the island mounted into #tutorial-feedback-mount.
      await page
        .locator('#tutorial-feedback-popup', { hasText: 'Likely to recommend to a colleague' })
        .waitFor({ state: 'visible', timeout: 15_000 });

      expect(islandFailures, `tutorial-feedback island 404'd: ${islandFailures.join(', ')}`).toHaveLength(0);
      expect(
        await page.locator('#tutorial-feedback-popup .feedback-btn').count(),
        'detailed feedback form did not render a submit button'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
