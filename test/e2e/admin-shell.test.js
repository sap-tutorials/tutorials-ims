// e2e: authenticated admin-shell load + Fiori Elements sub-app render (#1338).
// Path: browser → approuter /admin-ui/ (XSUAA) → sap.tnt.ToolPage shell →
//       #missions componentUsage (sap.tutorials.admin.missions) → CAP /admin OData.
// Route '#missions' is the bare hash pattern from app/admin-shell/webapp/
// manifest.json (verified — NOT a '-display' suffix). A rendered list proves
// the whole shell → headless-componentUsage → OData plumbing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: admin-shell (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('#missions loads a Fiori Elements list inside the shell', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#missions', { waitUntil: 'domcontentloaded' });
      // FE list surfaces as sap.m.List or sap.ui.table.Table. Role-first with a
      // UI5-class fallback (role=grid isn't emitted consistently across versions).
      await page
        .locator('[role="list"], [role="grid"], .sapMList, .sapUiTable')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      expect(
        await page.locator('[role="list"], [role="grid"], .sapMList, .sapUiTable').count()
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
