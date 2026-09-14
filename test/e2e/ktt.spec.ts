// test/e2e/ktt.spec.ts
//
// e2e: Kasimir Teaches TLAs island at /explore/ktt/
//
// Two post-deploy checks:
//   1. SSR shell renders (h1 title + unit list visible before JS hydrates)
//   2. Interactive flow: Start → skill-tree map → first unlocked lesson → answer
//      a drill → feedback/Next button renders (client-side engine is self-contained;
//      backend calls are best-effort/fail-open and are not asserted here)
//
// Self-skips when PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL is absent
// (repo e2e convention, #1338). `npm test` (unit suite) is unaffected.
//
// Run post-deploy only:
//   npx vitest run --project e2e test/e2e/ktt.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /explore/ktt/ (Kasimir Teaches TLAs)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('SSR shell renders h1 and unit list before JS hydrates', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/explore/ktt/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response!.status(), 'unexpected status for /explore/ktt/').toBe(200);
      // SSR shell: h1 page title and unit <li> items baked by Hugo into ktt.html layout
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('ul li').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  it('Start → skill-tree map → first lesson → answer drill → feedback renders', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/explore/ktt/', { waitUntil: 'domcontentloaded' });

      // Wait for Vue island to hydrate: Start button must appear in the landing screen
      const startBtn = page.locator('[data-testid="ktt-start"]');
      await startBtn.waitFor({ state: 'visible', timeout: 20_000 });
      await startBtn.click();

      // Skill-tree map: the first lesson node (always unlocked) must be visible
      const firstNode = page.locator('[data-testid^="ktt-node-"]').first();
      await firstNode.waitFor({ state: 'visible', timeout: 10_000 });
      await firstNode.click();

      // Lesson opened — advance through any leading story beats to reach the first drill.
      // Story beats show [data-testid="ktt-next"]; drill beats show [data-testid="ktt-choice"].
      const choiceBtn = page.locator('[data-testid="ktt-choice"]').first();
      const nextBtn = page.locator('[data-testid="ktt-next"]');

      for (let i = 0; i < 8; i++) {
        if (await choiceBtn.isVisible().catch(() => false)) break;
        const hasNext = await nextBtn.isVisible().catch(() => false);
        if (hasNext) await nextBtn.click();
        // Allow Vue reactivity to settle between story beat advances
        await page.waitForTimeout(300);
      }

      // Now on a drill beat — click the first choice (correct or wrong: doesn't matter)
      await choiceBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await choiceBtn.click();

      // After answering, Kasimir feedback renders and the Next / Try Again button appears
      await nextBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await expect(nextBtn).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
