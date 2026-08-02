// e2e: Devtoberfest rail navigation + Rules/FAQ pages.
// Asserts the 7-item nav rail renders on /devtoberfest/ and that both
// the Rules and FAQ pages load without error boxes.
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only: npx vitest run --project e2e test/e2e/devtoberfest-rail-nav.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: devtoberfest rail nav + rules/faq', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  // ── 1. Landing page rail ──────────────────────────────────────────────────
  it('anonymous /devtoberfest/ renders exactly 7 rail links', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> (never <article>), #1338.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island mounts into #devtoberfest-mount; wait for hydration.
      await page.locator('#devtoberfest-mount').waitFor({ state: 'attached', timeout: 20_000 });

      expect(await page.locator('.dtf-rail-item').count()).toBe(7);
    } finally {
      await context.close();
    }
  });

  // ── 2. Rules page ─────────────────────────────────────────────────────────
  it('anonymous /devtoberfest/rules/ loads with no error box and shows Rules title', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/rules/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island mounts into #devtoberfest-rules-mount; wait for hydration.
      await page.locator('#devtoberfest-rules-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // The page may show rendered rules OR the friendly empty-state — both are
      // acceptable; only the error box must be absent.
      expect(
        await page.locator('.dtf-doc-error').count(),
        'rules page must not show an error box'
      ).toBe(0);

      // Title is always rendered regardless of content state.
      const titleText = await page.locator('.dtf-doc-title').first().textContent();
      expect(titleText, 'rules title should contain "Rules"').toContain('Rules');
    } finally {
      await context.close();
    }
  });

  // ── 3. FAQ page ───────────────────────────────────────────────────────────
  it('anonymous /devtoberfest/faq/ loads with no error box and shows FAQ title', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/devtoberfest/faq/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Island mounts into #devtoberfest-faq-mount; wait for hydration.
      await page.locator('#devtoberfest-faq-mount').waitFor({ state: 'attached', timeout: 20_000 });

      // The page may show rendered FAQ OR the friendly empty-state — both are
      // acceptable; only the error box must be absent.
      expect(
        await page.locator('.dtf-doc-error').count(),
        'faq page must not show an error box'
      ).toBe(0);

      // Title is always rendered regardless of content state.
      const titleText = await page.locator('.dtf-doc-title').first().textContent();
      expect(titleText, 'faq title should contain "FAQ"').toContain('FAQ');
    } finally {
      await context.close();
    }
  });
});
