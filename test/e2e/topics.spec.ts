// test/e2e/topics.spec.ts
//
// e2e: tag-tree /topics/ pages.
//
// Three post-deploy checks driven via playwright-core inside plain vitest
// (same pattern as topic-clusters-band.spec.ts and ui5-split.e2e.test.ts —
// deliberately NOT @playwright/test, to avoid a second test-runner dep;
// see _browser.js comment).
//
// Self-skips when PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL is absent — so
// `npm test` (unit suite) and credential-less local runs are never affected.
//
// Run against a deployed approuter:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/topics.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /topics/ pages (tag-tree feature)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('topics index renders a tree and search links to navigator', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response!.status(), 'unexpected status for /topics/').toBe(200);

      await expect(page.locator('#topics-tree-root')).toBeVisible();
      await expect(page.locator('details summary').first()).toBeVisible();
      await expect(page.locator('a[href="/tutorial-navigator/"]').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  it('a topic leaf navigates to a detail page with tutorials', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      const firstTopic = page.locator('#topics-tree-root a[href^="/topics/"]').first();
      await firstTopic.click();
      await page.waitForURL(/\/topics\/[a-z0-9-]+\//);
      expect(page.url()).toMatch(/\/topics\/[a-z0-9-]+\//);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.topic-tutorials, main')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  it('/search/?q= redirects to the navigator', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/search/?q=cap', { waitUntil: 'domcontentloaded' });
      expect(page.url()).toMatch(/\/tutorial-navigator\//);
    } finally {
      await context.close();
    }
  });
});
