// e2e: admin Tutorials Object Page "Active Quarantine" facet (#2586).
// Path: browser → approuter /admin-ui/#tutorials (XSUAA) → sap.tnt.ToolPage shell →
//       sap.tutorials.admin.tutorials FE List Report → row-click → ObjectPage →
//       CAP /admin/Tutorials?...$expand=quarantineCurrent OData.
//
// #2586 adds an "Active Quarantine" facet to the Tutorials OP, bound to the
// Tutorials.quarantineCurrent association (slug → QuarantineEventsCurrent, the
// #2585 live set). A force-rebuild that quarantines a tutorial at pre-publish
// validation now surfaces here instead of looking like a silent success.
//
// A unit test proves the association + $expand server-side (see
// srv/__tests__/admin-service-quarantine-facet.test.js). This e2e locks the
// SHIPPED seam that unit tests can't (the #1371/#1378 "features ship dead, gates
// green" pattern): that the FE ObjectPage actually requests the expand and
// renders the section. Both assertions are DATA-INDEPENDENT — they do not
// require any tutorial on the target env to be currently quarantined:
//   1. Opening a Tutorial OP issues an OData read carrying
//      $expand=quarantineCurrent (proves the facet annotation + association
//      shipped and FE binds them).
//   2. The "Active Quarantine" section anchor renders in the OP (proves the
//      ReferenceFacet is wired into @UI.Facets).
//
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL + credentials (repo e2e
// convention, #1338). Run post-deploy only:
//   npx vitest run --project e2e test/e2e/admin-tutorials-quarantine-facet.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

const LIST_LOCATOR = '[role="list"], [role="grid"], .sapMList, .sapUiTable';
const ROW_LOCATOR = '.sapMListItems .sapMLIB, .sapUiTableRow';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: admin Tutorials quarantine facet', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('opening a Tutorial OP issues a /admin/Tutorials read with $expand=quarantineCurrent', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#tutorials', { waitUntil: 'domcontentloaded' });
      await page.locator(LIST_LOCATOR).first().waitFor({ state: 'visible', timeout: 30_000 });

      // Arm the request matcher before the row-click so we catch the OP read.
      // FE expands facet associations when the ObjectPage binds; quarantineCurrent
      // is one of them. The term is data-independent — any Tutorial OP read works.
      const expandRequest = page.waitForRequest(
        (req) =>
          /\/admin\/Tutorials/.test(req.url()) &&
          /[?&]\$expand=[^&]*quarantineCurrent/.test(decodeURIComponent(req.url())),
        { timeout: 30_000 }
      );

      const firstRow = page.locator(ROW_LOCATOR).first();
      await firstRow.waitFor({ state: 'visible', timeout: 30_000 });
      await firstRow.click();

      const req = await expandRequest;
      expect(
        decodeURIComponent(req.url()),
        'Tutorial OP read should $expand quarantineCurrent'
      ).toMatch(/[?&]\$expand=[^&]*quarantineCurrent/);
    } finally {
      await context.close();
    }
  });

  it('the Tutorial OP renders the "Active Quarantine" section', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/admin-ui/#tutorials', { waitUntil: 'domcontentloaded' });
      await page.locator(LIST_LOCATOR).first().waitFor({ state: 'visible', timeout: 30_000 });

      const firstRow = page.locator(ROW_LOCATOR).first();
      await firstRow.waitFor({ state: 'visible', timeout: 30_000 });
      await firstRow.click();

      // Wait for the ObjectPage to render, then assert the facet section anchor.
      // FE renders a ReferenceFacet's Label as section text; "Active Quarantine"
      // appears whether or not the facet has rows (empty section still renders).
      await page.waitForFunction(
        () => document.querySelector('.sapUxAPObjectPageLayout') !== null,
        { timeout: 30_000 }
      );
      await page.getByText('Active Quarantine', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      expect(
        await page.getByText('Active Quarantine', { exact: false }).count(),
        '"Active Quarantine" facet section should render on the Tutorial OP'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
