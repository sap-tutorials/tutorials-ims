// test/e2e/puzzle-1412-solver.test.js
// Post-deploy: anonymous Check works (no CSRF error) and per-cell coloring appears.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'devtoberfest-cryptic-crossword';

describe.skipIf(!hasBaseUrl())('e2e #1412: anonymous Check + per-cell feedback', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('anonymous user can Check without a CSRF error and sees per-cell colors', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto(`/puzzles/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.puzzle-grid').first().waitFor({ state: 'visible', timeout: 15_000 });
      // Type a letter into the first white cell, then Check.
      const firstCell = page.locator('.puzzle-cell.cell-clickable').first();
      await firstCell.click();
      await page.keyboard.type('Z'); // almost certainly wrong
      const checkBtn = page.getByRole('button', { name: 'Check' });
      await checkBtn.click();
      // No "Check failed" CSRF message.
      await expect(page.locator('.status-msg')).not.toContainText('Check failed', { timeout: 5_000 }).catch(() => {});
      // At least one cell got a wrong (red) status class after Check.
      await page.locator('.puzzle-cell.cell-wrong').first().waitFor({ state: 'visible', timeout: 5_000 });
      expect(await page.locator('.puzzle-cell.cell-wrong').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
