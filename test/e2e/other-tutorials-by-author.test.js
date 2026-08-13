// e2e: other tutorials by author (#1732).
// Path 1: browser → approuter /authors/:login → CAP /authors → author page (Hugo).
// Path 2: browser → approuter /tutorials/:slug → more-from-author rail (Hugo).
// Discovers a multi-tutorial author from /data/author_index.json (served statically).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, BASE_URL } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: other tutorials by author (#1732)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('author page lists tutorials', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // Discover a login with >= 2 tutorials from the built data file served statically.
      const authorIndexRes = await page.request.get('/data/author_index.json').catch(() => null);
      if (!authorIndexRes || !authorIndexRes.ok()) {
        throw new Error('author_index.json not served at this host — skipping');
      }
      const idx = await authorIndexRes.json();
      const login = Object.keys(idx).find((k) => !idx[k].advocateSlug && idx[k].tutorials.length >= 2);
      if (!login) {
        throw new Error('no non-advocate author with >= 2 tutorials — skipping');
      }

      const response = await page.goto(`/authors/${login}/`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /authors/${login}/`).toBe(200);

      // Author page renders .author-page h1 with "Tutorials by".
      await page.locator('.author-page h1').waitFor({ state: 'visible', timeout: 15_000 });
      const h1Text = await page.locator('.author-page h1').textContent();
      expect(h1Text).toContain('Tutorials by');

      // At least 2 tutorial cards rendered (.next-steps-rail-card or .next-steps-card).
      const cardCount = await page.locator('.next-steps-rail-card, .next-steps-card').count();
      expect(cardCount, 'expected >= 2 tutorial cards on author page').toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  it('tutorial page shows the more-from-author rail', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // Discover an author with >= 2 tutorials.
      const authorIndexRes = await page.request.get('/data/author_index.json').catch(() => null);
      if (!authorIndexRes || !authorIndexRes.ok()) {
        throw new Error('author_index.json not served at this host — skipping');
      }
      const idx = await authorIndexRes.json();
      const login = Object.keys(idx).find((k) => idx[k].tutorials.length >= 2);
      if (!login) {
        throw new Error('no author with >= 2 tutorials — skipping');
      }

      // Navigate to the first tutorial of that author.
      const slug = idx[login].tutorials[0].slug;
      const response = await page.goto(`/tutorials/${slug}`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /tutorials/${slug}`).toBe(200);

      // The .more-from-author rail is visible.
      await page.locator('.more-from-author').waitFor({ state: 'visible', timeout: 15_000 });
      const isVisible = await page.locator('.more-from-author').isVisible();
      expect(isVisible, '.more-from-author rail should be visible').toBe(true);
    } finally {
      await context.close();
    }
  });
});
