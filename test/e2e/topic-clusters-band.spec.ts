// e2e: multi-source topic-cluster band on the homepage (expand-topic-clusters-kg).
// Checks the [data-app="topic-clusters-band"] island is present (when KG community
// data exists) and renders at least one cluster card.
//
// Band is empty-by-omission: when no KG Louvain community data is available (e.g.
// a fresh DEV deploy before the nightly job runs), the island is simply absent from
// the baked HTML. The test treats both "absent" and "present+visible" as valid states
// so it never false-fails on fresh envs.
//
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only:
//   npx vitest run --project e2e test/e2e/topic-clusters-band.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: homepage topic-cluster band (multi-source)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('topic-cluster band renders with at least one cluster card when data exists', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response!.status(), `unexpected status for /`).toBe(200);

      // Band is empty-by-omission when no KG community data is available.
      // Only assert cluster cards when the band is present in the DOM.
      const band = page.locator('[data-app="topic-clusters-band"]');
      const bandCount = await band.count();
      if (bandCount > 0) {
        await band.waitFor({ state: 'visible', timeout: 20_000 });
        // At least one cluster card must be rendered when the band is present.
        await expect(band.locator('.hp-topic-clusters__cluster').first()).toBeVisible();
      }
      // If bandCount === 0, the env has no KG community data yet — that is valid.
    } finally {
      await context.close();
    }
  });
});
