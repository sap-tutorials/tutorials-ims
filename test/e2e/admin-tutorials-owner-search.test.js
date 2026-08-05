// e2e: admin Tutorials owner/author search + Owner column (#1491, follow-up to #1490).
// Path: browser → approuter /admin-ui/#tutorials (XSUAA) → sap.tnt.ToolPage shell →
//       sap.tutorials.admin.tutorials FE List Report → CAP /admin/Tutorials OData.
//
// Locks the cross-PR seam that #1490 (owner/email search box) and #1491 (scalar
// flatten → wildcard Owner filter + FK-author search) landed across: a per-PR
// unit test can't prove the shipped FE List Report actually wires owner search
// (see the #1371/#1378 "features ship dead, gates green" pattern). Two
// data-independent assertions:
//   1. The Owner and Owner Email columns render (proves the @UI.LineItem
//      annotations shipped and bind the flattened scalars).
//   2. Typing in the FE search field fires a /admin/Tutorials request carrying
//      $search (proves the @cds.search widening reaches the running service).
//
// Route '#tutorials' is the bare hash pattern from app/admin-shell/webapp/
// manifest.json (verified — NOT a '-display' suffix; that's only the
// crossNavigation inbound id in the sub-app manifest).
//
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL + credentials (repo e2e
// convention, #1338). Run post-deploy only:
//   npx vitest run --project e2e test/e2e/admin-tutorials-owner-search.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

// FE list surfaces as sap.m.List or sap.ui.table.Table; role=grid isn't emitted
// consistently across UI5 versions, so pair roles with UI5-class fallbacks.
const LIST_LOCATOR = '[role="list"], [role="grid"], .sapMList, .sapUiTable';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: admin Tutorials owner search', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('#tutorials renders the Owner and Owner Email columns', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#tutorials', { waitUntil: 'domcontentloaded' });
      await page.locator(LIST_LOCATOR).first().waitFor({ state: 'visible', timeout: 30_000 });

      // Both columns come from @UI.LineItem on AdminService.Tutorials. Exact-name
      // column headers keep 'Owner' from also matching 'Owner Email'.
      await page
        .getByRole('columnheader', { name: 'Owner', exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      expect(
        await page.getByRole('columnheader', { name: 'Owner', exact: true }).count(),
        'Owner column header should render'
      ).toBeGreaterThan(0);
      expect(
        await page.getByRole('columnheader', { name: 'Owner Email', exact: true }).count(),
        'Owner Email column header should render'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('typing in the search field issues a /admin/Tutorials $search request', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#tutorials', { waitUntil: 'domcontentloaded' });
      await page.locator(LIST_LOCATOR).first().waitFor({ state: 'visible', timeout: 30_000 });

      // FE List Report filter-bar search field. Role-first with a UI5-class
      // fallback (the search box is a sap.m.SearchField → input.sapMSFI).
      const searchField = page
        .getByRole('searchbox')
        .or(page.locator('.sapMSF input, input.sapMSFI'))
        .first();
      await searchField.waitFor({ state: 'visible', timeout: 30_000 });

      // Any owner/author query goes through OData $search → HANA CONTAINS. The
      // term need not match a row — we assert the request is issued with the
      // $search parameter, which is data-independent and proves the wiring.
      const searchRequest = page.waitForRequest(
        (req) => /\/admin\/Tutorials/.test(req.url()) && /[?&]\$search=/.test(req.url()),
        { timeout: 30_000 }
      );
      await searchField.fill('sap');
      await searchField.press('Enter');

      const req = await searchRequest;
      expect(req.url(), 'search request should carry a $search parameter').toMatch(/[?&]\$search=/);
    } finally {
      await context.close();
    }
  });
});
