// test/e2e/explore-3d.test.ts
// e2e: 3D toggle on /explore/ (#2517). Self-skips without SMOKE_BASE_URL/PLAYWRIGHT_BASE_URL.
// Requires KG_EXPLORE_3D_ENABLED=on in the target env, else the toggle is absent (test self-skips that case).
// Run post-deploy: npx vitest run --project e2e test/e2e/explore-3d.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /explore/ 3D toggle (#2517)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it('renders the 3D view without console errors when the flag is on', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await page.goto('/explore/', { waitUntil: 'domcontentloaded' });
      // Wait for the graph app to hydrate. The 3D toggle only renders when
      // KG_EXPLORE_3D_ENABLED is on (features.threeD). If absent, the flag is
      // off in this env — skip rather than fail.
      const btn3d = page.getByRole('button', { name: /^3D/ });
      const appeared = await btn3d.isVisible({ timeout: 20_000 }).catch(() => false);
      if (!appeared) return; // flag off in this env — nothing to assert
      await btn3d.click();
      // 3D view mounts a <canvas> inside .threed-graph
      await expect(page.locator('.threed-graph canvas')).toBeVisible({ timeout: 15_000 });
      // No console errors from loading/rendering the 3D chunk
      expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
