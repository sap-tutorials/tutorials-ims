// e2e: Concepts "Preview merges" async fix (#1531).
// Smoke test that navigates to the Concepts list report in the admin UI,
// clicks the "Preview merges" toolbar button, and asserts:
//   (a) a result dialog (candidates found) OR a no-candidates toast appears, AND
//   (b) "Preview failed: 504" never appears.
//
// The 504 regression was caused by the synchronous finder blocking the server.
// Tasks 1-5 moved it to fire-and-poll. This spec detects a regression back to 504.
//
// Auth + baseURL harness mirrors admin-shell.test.js exactly (vitest + playwright-core,
// NOT @playwright/test). Self-skips when SMOKE_BASE_URL/credentials are absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

// Poll ceiling for the async job: ~190s (3 min client timeout + buffer).
const RESULT_TIMEOUT_MS = 200_000;

describe.skipIf(!hasBaseUrl() || !hasCredentials())(
  'e2e: Concepts — Preview merges (#1531)',
  () => {
    let browser;
    beforeAll(async () => {
      requireCredentials();
      browser = await launchBrowser();
    });
    afterAll(async () => {
      await browser?.close();
    });

    it(
      'clicking Preview merges shows a result without a 504',
      async () => {
        const { context, page } = await newPage(browser);
        try {
          await page.goto('/admin-ui/#concepts', { waitUntil: 'domcontentloaded' });

          // Wait for the Concepts List Report to render (role-first, UI5-class fallback).
          await page
            .locator('[role="list"], [role="grid"], .sapMList, .sapUiTable')
            .first()
            .waitFor({ state: 'visible', timeout: 30_000 });

          // Locate the "Preview merges" toolbar button (i18n: previewMergesButton).
          // Role-first; UI5 toolbar buttons carry role="button".
          const btn = page.getByRole('button', { name: 'Preview merges' });
          await btn.waitFor({ state: 'visible', timeout: 15_000 });
          await btn.click();

          // After the click, the client kicks off an async background scan and starts
          // polling. Within the poll ceiling (~190 s) one of three things appears:
          //   1. A MessageBox/Dialog with candidate pairs  (merge candidates found)
          //   2. A MessageToast with "no candidates" text  (zero near-duplicates)
          //   3. A MessageBox with "Preview failed: 504"   (regression — must NOT appear)
          //
          // We assert that (1) or (2) is visible, and (3) never surfaces.
          //
          // UI5 MessageBox renders as .sapMMessageBox (a subclass of sap.m.Dialog);
          // toasts use .sapMMessageToast.
          const resultLocator = page.locator(
            '.sapMMessageBox, .sapMDialog, .sapMMessageToast'
          );
          await resultLocator.first().waitFor({ state: 'visible', timeout: RESULT_TIMEOUT_MS });

          // The critical regression guard: a 504 surfaced as "Preview failed: 504" in
          // a MessageBox error dialog. Confirm it never appears.
          expect(await page.getByText(/Preview failed: 504/).count()).toBe(0);
        } finally {
          await context.close();
        }
      },
      RESULT_TIMEOUT_MS + 60_000 // vitest per-test timeout: poll ceiling + 60 s margin
    );
  }
);
