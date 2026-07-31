// test/e2e/puzzle-designer.test.js
// Post-deploy smoke: authenticated admin user creates a puzzle via the
// Builder admin UI (title, slug, word list → word count badge, grid picker,
// fill, export, save).
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent — `npm test`
// (unit tier) is always unaffected.
// Run manually:
//   SMOKE_BASE_URL=https://... SMOKE_TECH_USER=... SMOKE_TECH_PASSWORD=... \
//   npx vitest --project e2e run test/e2e/puzzle-designer.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())(
  'e2e: puzzle designer admin UI (authenticated)',
  () => {
    let browser;
    beforeAll(async () => {
      requireCredentials();
      browser = await launchBrowser();
    });
    afterAll(async () => {
      await browser?.close();
    });

    it('create → word list → fill → export → save', async () => {
      const { context, page } = await newPage(browser);
      try {
        // Navigate to the puzzles builder in the admin shell
        await page.goto('/admin-ui/#puzzles', { waitUntil: 'domcontentloaded' });

        // Wait for the Builder page to be visible (list mode shows "Create New")
        // The button has type="Emphasized" in the headerContent
        await page
          .locator('[role="button"]')
          .filter({ hasText: 'Create New' })
          .waitFor({ state: 'visible', timeout: 30_000 });

        // Click Create New to enter edit mode
        await page.locator('[role="button"]').filter({ hasText: 'Create New' }).click();

        // Fill in Title — Input placeholder "e.g. SAP BTP Basics"
        // The UI5 Input renders as <input placeholder="e.g. SAP BTP Basics">
        await page.locator('input[placeholder="e.g. SAP BTP Basics"]').fill('E2E Test Puzzle');

        // Fill in Slug
        await page.locator('input[placeholder="e.g. btp-basics"]').fill('e2e-test-puzzle');

        // Fill word list — TextArea placeholder contains "Paste words here"
        await page
          .locator('textarea[placeholder*="Paste words here"]')
          .fill('SAP\nCAP\nBTP');

        // Word count badge: the Text control shows "{wordCount} words"
        await expect(
          page.locator('text=/3 words/')
        ).toBeVisible({ timeout: 5_000 });

        // Open the grid picker dialog
        await page.locator('[role="button"]').filter({ hasText: 'Select Grid' }).click();

        // The dialog fragment id is "gridPickerDialog"; wait for a list item inside it
        await page
          .locator('[id*="gridPickerDialog"]')
          .locator('[role="listitem"], li')
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Click the first template to apply it
        await page
          .locator('[id*="gridPickerDialog"]')
          .locator('[role="listitem"], li')
          .first()
          .click();

        // Fill the grid using the word list
        await page.locator('[role="button"]').filter({ hasText: 'Fill Grid' }).click();

        // Wait for fill to finish — any terminal status from _finishFill:
        // "Solved", "Partially filled", "No solution from this word list",
        // "Timed out — no complete fill", "Fill error"
        await expect(
          page.locator('text=/Solved|Partially filled|No solution|Timed out|Fill error/')
        ).toBeVisible({ timeout: 30_000 });

        // Export: triggers a download
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('[role="button"]').filter({ hasText: 'Export' }).click(),
        ]);
        expect(download.suggestedFilename()).toContain('e2e-test-puzzle');

        // Save the puzzle
        await page.locator('[role="button"]').filter({ hasText: 'Save' }).click();

        // Confirm save toast — "Puzzle saved"
        await expect(
          page.locator('text=/Puzzle saved/')
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        await context.close();
      }
    });
  }
);
