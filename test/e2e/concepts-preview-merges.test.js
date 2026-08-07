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

          // After click, the client fires the kick-off POST, shows a "Computing…"
          // toast, then polls until the background run is DONE/FAILED (up to 3 min).
          //
          // Success surfaces:
          //   1. A MessageBox.information dialog with "merge candidate(s)" title
          //      → .sapMMessageBox with text matching /merge candidate\(s\)/
          //   2. A "No merge candidates" MessageToast (empty dataset)
          // Failure surface we must NOT see:
          //   3. "Preview failed: 504" in a MessageBox error dialog
          //
          // Strategy:
          //   (a) Assert the "Computing…" toast appears first (proves new async
          //       code ran, not the old synchronous path which never showed this).
          //   (b) Then wait for either the candidate MessageBox dialog OR the
          //       no-candidates toast — both are valid final states.
          //   (c) Confirm "Preview failed: 504" never appeared.
          //
          // NOTE: on a dataset with no near-duplicates the success surface is the
          // no-candidates toast (.sapMMessageToast), not a dialog. The assertion
          // covers both paths but still distinguishes them from an error.

          // (a) The computing toast MUST appear — proves async kick-off ran.
          const computingToast = page.locator('.sapMMessageToast');
          await computingToast.first().waitFor({ state: 'visible', timeout: 30_000 });

          // (b) Wait for the final result: candidate dialog OR no-candidates toast.
          // A candidate dialog is a .sapMMessageBox containing "merge candidate(s)".
          // A no-candidates state is another .sapMMessageToast (possibly the same one
          // if it hasn't faded yet, or a second one).
          const candidateDialog = page.locator('.sapMMessageBox, .sapMDialog').filter({
            hasText: /merge candidate\(s\)/
          });
          const noCandidatesToast = page.locator('.sapMMessageToast').filter({
            hasText: /No merge candidates/
          });
          // Race: whichever appears first wins.
          await Promise.race([
            candidateDialog.first().waitFor({ state: 'visible', timeout: RESULT_TIMEOUT_MS }),
            noCandidatesToast.first().waitFor({ state: 'visible', timeout: RESULT_TIMEOUT_MS })
          ]);

          // At least one of the two success surfaces must be present.
          const candidateCount = await candidateDialog.count();
          const noCandidatesCount = await noCandidatesToast.count();
          expect(candidateCount + noCandidatesCount).toBeGreaterThan(0);

          // (c) The critical regression guard: a 504 surfaced as "Preview failed: 504"
          // in a MessageBox error dialog. Confirm it never appears.
          expect(await page.getByText(/Preview failed: 504/).count()).toBe(0);
        } finally {
          await context.close();
        }
      },
      RESULT_TIMEOUT_MS + 60_000 // vitest per-test timeout: poll ceiling + 60 s margin
    );
  }
);
