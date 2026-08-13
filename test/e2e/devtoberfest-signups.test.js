// e2e: authenticated admin-shell → Devtoberfest Signups Analytical List Page (spec 2026-08-13).
// Path: browser → approuter /admin-ui/ (XSUAA) → sap.tnt.ToolPage shell →
//       #devtoberfestSignups componentUsage (sap.tutorials.admin.devtoberfestSignups,
//       sap.fe.templates.AnalyticalListPage) → CAP /admin OData $apply over
//       DevtoberfestSignupAnalytics. A rendered chart/analytical table proves the
//       whole shell → headless-componentUsage → aggregated-OData plumbing.
// Route '#devtoberfestSignups' is the generated shell route name (folder + camelName;
// see app/admin-shell/scripts/admin-shell-overrides.js order/prefix entries).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: Devtoberfest Signups ALP (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('#devtoberfestSignups renders the analytical chart/table inside the shell', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#devtoberfestSignups', { waitUntil: 'domcontentloaded' });
      // ALP surfaces a chart (sap.chart.Chart → .sapChart / .sapMFlexBox chart area)
      // and an analytical table (sap.ui.table.AnalyticalTable → .sapUiTable) plus a
      // filter bar. Role-first with UI5-class fallbacks since role attributes vary
      // across versions.
      const surface = '[role="grid"], .sapUiTable, .sapChart, .sapMList, .sapUiMdcChart';
      await page.locator(surface).first().waitFor({ state: 'visible', timeout: 30_000 });
      expect(await page.locator(surface).count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
