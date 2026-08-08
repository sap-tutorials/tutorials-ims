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
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

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

// #1551: clicking a Featured Task row must open an editable ObjectPage. Before
// the fix the operations manifest had a /FeaturedTasks List Report with no
// `navigation` block and no ObjectPage target/route, so a row-click went
// nowhere and the item could never be edited. This authenticated spec drives
// the real admin-shell DOM: it loads the Featured Tasks list, clicks the first
// row, and asserts the FE ObjectPage rendered (hash advances to
// FeaturedTasks(...) and an object-page surface is visible).
describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: featured tasks edit navigation (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('#operations row-click opens the editable Featured Task ObjectPage', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#operations', { waitUntil: 'domcontentloaded' });

      // Wait for the FE List Report table to render, then click its first data row.
      const table = page.locator('.sapMList, .sapUiTable').first();
      await table.waitFor({ state: 'visible', timeout: 30_000 });

      const firstRow = page
        .locator('.sapMListItems .sapMLIB, .sapUiTableRow')
        .first();
      await firstRow.waitFor({ state: 'visible', timeout: 30_000 });
      await firstRow.click();

      // The FE ObjectPage advances the hash to FeaturedTasks(<key>) and renders
      // an sap.uxap ObjectPageLayout. Either signal confirms detail navigation.
      await page.waitForFunction(
        () =>
          /FeaturedTasks\(/.test(window.location.hash) ||
          document.querySelector('.sapUxAPObjectPageLayout') !== null,
        { timeout: 30_000 }
      );

      const onDetail = await page.evaluate(
        () =>
          /FeaturedTasks\(/.test(window.location.hash) ||
          document.querySelector('.sapUxAPObjectPageLayout') !== null
      );
      expect(onDetail, 'row-click did not open the Featured Task ObjectPage').toBeTruthy();
    } finally {
      await context.close();
    }
  });
});
