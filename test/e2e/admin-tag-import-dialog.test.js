// e2e: admin Tags → "Import…" dialog open + close (#1549).
// Path: browser → approuter /admin-ui/#tags (XSUAA) → sap.tnt.ToolPage shell →
//       sap.tutorials.admin.tags FE List Report → TagImportDialog fragment.
//
// Locks the cross-file seam that broke the dialog: the fragment
// (TagImportDialog.fragment.xml) is loaded by the PLAIN module
// TagImportController.js with `controller: handlers`, but its buttons had
// referenced handlers via the ControllerExtension `.extension.<ns>.onClose`
// syntax — which never resolves against a plain fragment-controller object.
// Result: every dialog button (Close included) was a no-op. A per-PR unit
// test can't catch this — the wiring only fails through the real fragment
// load path in the running FE app (the #1371/#1378 "features ship dead,
// gates green" pattern). Two assertions:
//   1. The "Import…" toolbar action opens the dialog (title "Import Tags").
//   2. Clicking "Close" dismisses it (proves the press handler resolves).
//
// Route '#tags' is the bare hash pattern from app/admin-shell/webapp/
// manifest.json (verified — routes[].pattern "tags").
//
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL + credentials (repo
// e2e convention, #1338). Run post-deploy only:
//   npx vitest run --project e2e test/e2e/admin-tag-import-dialog.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

const LIST_LOCATOR = '[role="list"], [role="grid"], .sapMList, .sapUiTable';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: admin Tags Import dialog', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('opens the Import dialog and closes it via the Close button', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#tags', { waitUntil: 'domcontentloaded' });
      await page.locator(LIST_LOCATOR).first().waitFor({ state: 'visible', timeout: 30_000 });

      // Toolbar action text is "Import…" (i18n tagImport.action, trailing
      // ellipsis char). Match by accessible name; the LR renders it as a
      // sap.m.Button in the table toolbar.
      const importButton = page
        .getByRole('button', { name: /Import/i })
        .first();
      await importButton.waitFor({ state: 'visible', timeout: 30_000 });
      await importButton.click();

      // Dialog title from i18n tagImport.dialog.title.
      const dialog = page.getByRole('dialog').filter({ hasText: 'Import Tags' });
      await dialog.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await dialog.count(), 'Import Tags dialog should open').toBeGreaterThan(0);

      // The regression: Close was wired via `.extension.<ns>.onClose`, which
      // did not resolve, so the dialog stayed open. Assert it actually goes
      // away after the click.
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      expect(
        await page.getByRole('dialog').filter({ hasText: 'Import Tags' }).count(),
        'Import Tags dialog should be dismissed after Close'
      ).toBe(0);
    } finally {
      await context.close();
    }
  });
});
