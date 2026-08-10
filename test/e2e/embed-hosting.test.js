// e2e: BAIP embedded / hosted tutorial modes (#1584).
// Verifies the pre-paint script (hugo/layouts/partials/head.html) sets
// html[data-embed=<mode>] from the ?embed= query param before first paint, and
// that the CSS cascade (hugo/assets/css/ui5-overrides.css) shows/hides the right
// chrome per mode.
//
// All cases are anonymous — embed modes are a rendering concern, no auth needed.
//
// Slug reused from test/e2e/tutorial-serve.test.js ('abap-cloud-ui-from-interface',
// a stable long-lived HANA-served tutorial). If it ever 404s, swap for another
// slug from test/a11y/urls.js.
//
// playwright-core has no web-first `expect` (that's @playwright/test); we assert
// the resolved value of the locator API with vitest `expect`, exactly like
// tutorial-serve.test.js. We confirm the pre-paint fired by reading
// html[data-embed] BEFORE checking element visibility.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'abap-cloud-ui-from-interface';

describe.skipIf(!hasBaseUrl())('e2e: embed hosted modes (unauthenticated)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('embed=none hides the shellbar and shows the escape pill', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto(`/tutorials/${SLUG}/?embed=none`, { waitUntil: 'domcontentloaded' });
      // Confirm the pre-paint script fired before asserting CSS-driven visibility.
      expect(await page.getAttribute('html', 'data-embed')).toBe('none');
      // Wait for the page body to render + the embed island to have run.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('ui5-shellbar#app-shellbar').isVisible()).toBe(false);
      expect(await page.locator('.embed-escape').isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('embed=minimal shows the slim bar and hides the real shellbar', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto(`/tutorials/${SLUG}/?embed=minimal`, { waitUntil: 'domcontentloaded' });
      expect(await page.getAttribute('html', 'data-embed')).toBe('minimal');
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.embed-bar').isVisible()).toBe(true);
      expect(await page.locator('ui5-shellbar#app-shellbar').isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('embed=reader applies the focus cascade (right col hidden)', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto(`/tutorials/${SLUG}/?embed=reader`, { waitUntil: 'domcontentloaded' });
      expect(await page.getAttribute('html', 'data-embed')).toBe('reader');
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('.tutorial-right-col').isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });
});
