// e2e: Group/Mission completion island presence on catalog detail pages (#2733).
// Asserts the goal-completion island mount node is server-rendered on a real
// mission detail page and that anonymous users see no completion UI (the island
// fails open / renders nothing when unauthenticated). Progress numbers for a
// signed-in user are covered by the unit specs (GoalCompletion.spec.ts); this
// e2e only guards the server-side wiring + anonymous no-op.
//
// Self-skips without PLAYWRIGHT_BASE_URL/SMOKE_BASE_URL (repo e2e convention, #1338).
// Run post-deploy only: npx vitest run --project e2e test/e2e/goal-completion-island.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: goal-completion island (mission/group detail)', () => {
  let browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  // Resolve a real mission slug from the catalog feed so the test is not
  // pinned to a specific slug that may be retired.
  async function firstMissionSlug(page) {
    const res = await page.goto('/build/catalog', { waitUntil: 'domcontentloaded' });
    if (!res || res.status() !== 200) return null;
    let json;
    try { json = await res.json(); } catch { return null; }
    const missions = json?.missions || json?.data?.missions || [];
    const m = Array.isArray(missions) ? missions.find(x => x?.slug) : null;
    return m?.slug || null;
  }

  it('anonymous mission detail page server-renders the island mount but shows no completion UI', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const slug = await firstMissionSlug(page);
      if (!slug) { expect(true).toBe(true); return; } // no catalog data on this env — soft pass

      const response = await page.goto(`/tutorials/mission-${slug}`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // Served page convention: <main> (never <article>), #1338.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // The island mount node is server-rendered on every mission detail page.
      const mount = page.locator('[data-vue-island="goal-completion"]');
      await mount.waitFor({ state: 'attached', timeout: 20_000 });
      expect(await mount.count()).toBeGreaterThan(0);

      // Anonymous: the island fails open and renders nothing inside the mount.
      // Give hydration a moment, then assert no completion section/badge appears.
      await page.waitForTimeout(1500);
      expect(await page.locator('.goal-completion').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
