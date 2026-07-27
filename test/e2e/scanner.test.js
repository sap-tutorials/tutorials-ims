// e2e: authenticated scanner UI load (#1338).
// Path: browser → approuter /scanner-ui/ (XSUAA scope $XSAPPNAME.MobileApp) →
//       UI5 sap.ndc.BarcodeScanner app.
// Assertion targets UI structure (the input field), NOT a contestant lookup —
// contestant IDs (8001/10001…) are unit-test fixtures and aren't guaranteed to
// exist in any deployed DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: scanner (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('scanner UI loads with an input field visible', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/scanner-ui/', { waitUntil: 'domcontentloaded' });
      // UI5 sap.m.Input renders as <input> inside div.sapMInputBase. Prefer the
      // textbox role, fall back to the UI5 class for version robustness.
      await page
        .locator('input[role="textbox"], .sapMInputBase input, input')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      expect(await page.locator('input').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
