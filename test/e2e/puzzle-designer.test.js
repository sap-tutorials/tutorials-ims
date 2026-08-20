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

    // Regression for issue #1909 ("Puzzle is not importing"). Create New enters
    // edit mode (list→edit visibility transition), then Import a JSON file. Before
    // the fix the file <input>'s change listener was only wired in the view's
    // onAfterRendering, which does not re-fire on that transition, so selecting a
    // file was a silent no-op. This drives the real file chooser and asserts the
    // builder was populated from the imported JSON.
    it('Create New → Import JSON populates the builder (issue #1909)', async () => {
      const { context, page } = await newPage(browser);
      try {
        await page.goto('/admin-ui/#puzzles', { waitUntil: 'domcontentloaded' });

        await page
          .locator('[role="button"]')
          .filter({ hasText: 'Create New' })
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('[role="button"]').filter({ hasText: 'Create New' }).click();

        // Wait until edit mode is active (Title input present).
        await page
          .locator('input[placeholder="e.g. SAP BTP Basics"]')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // A well-formed 5x5 puzzle in the exact shape attached to #1909: numeric
        // STRING rows/cols and {black, number} grid cells.
        const puzzle = {
          formatVersion: 1,
          rows: '5',
          cols: '5',
          grid: Array.from({ length: 5 }, () =>
            Array.from({ length: 5 }, () => ({ black: false, number: null }))),
          clues: { '0-0-across': 'Atop' },
          hints: {},
          answers: { '0,0': 'A' },
          title: 'Imported Warmup Puzzle',
          slug: 'e2e-imported-warmup-1909'
        };

        // Clicking Import calls input.click(), opening the native file chooser.
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('[role="button"]').filter({ hasText: 'Import' }).click()
        ]);
        await chooser.setFiles({
          name: 'warmup-devtoberfest-2026.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(puzzle))
        });

        // The success toast confirms onImportFile actually ran.
        await expect(page.locator('text=/Puzzle imported/')).toBeVisible({ timeout: 10_000 });

        // The builder model was populated from the file (two-way bound inputs).
        await expect(
          page.locator('input[placeholder="e.g. btp-basics"]')
        ).toHaveValue('e2e-imported-warmup-1909', { timeout: 5_000 });
        await expect(
          page.locator('input[placeholder="e.g. SAP BTP Basics"]')
        ).toHaveValue('Imported Warmup Puzzle');
      } finally {
        await context.close();
      }
    });
    // Regression for issue #1930 ("Toggle of grid squares not working"). In
    // design mode, clicking a white cell turns it black; clicking a black cell
    // must turn it back to white. Before the fix, geom.setBlack forced black:true
    // so the second click was a no-op.
    it('design mode toggles a grid square black then back to white (issue #1930)', async () => {
      const { context, page } = await newPage(browser);
      try {
        await page.goto('/admin-ui/#puzzles', { waitUntil: 'domcontentloaded' });

        await page
          .locator('[role="button"]')
          .filter({ hasText: 'Create New' })
          .waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('[role="button"]').filter({ hasText: 'Create New' }).click();

        // Apply a grid template (leaves the builder in "design" sub-mode).
        await page.locator('[role="button"]').filter({ hasText: 'Select Grid' }).click();
        const firstTemplate = page
          .locator('[id*="gridPickerDialog"]')
          .locator('[role="listitem"], li')
          .first();
        await firstTemplate.waitFor({ state: 'visible', timeout: 10_000 });
        await firstTemplate.click();

        // Pick a non-black, off-mirror-axis cell so the first click definitely
        // turns it black regardless of the template's symmetry.
        const cell = page.locator('table[role="grid"] td[data-r="0"][data-c="1"]');
        await cell.waitFor({ state: 'visible', timeout: 10_000 });
        const bg = () => cell.evaluate((el) => getComputedStyle(el).backgroundColor);

        const before = await bg();
        // First click → black (#222 → rgb(34, 34, 34)).
        await cell.click();
        await expect
          .poll(bg, { timeout: 5_000 })
          .toBe('rgb(34, 34, 34)');

        // Second click → back to white (no longer black).
        await cell.click();
        await expect
          .poll(bg, { timeout: 5_000 })
          .not.toBe('rgb(34, 34, 34)');
        expect(await bg()).toBe(before);
      } finally {
        await context.close();
      }
    });
  }
);
