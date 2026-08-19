// e2e: unauthenticated Devtoberfest scavenger-hunt clues (#1908).
// Three easter-egg clues, one per public page, sourced from
// hugo/data/scavenger_hunt.json and rendered by the scavenger-hunt partial +
// shortcode. All anonymous — no auth, no CAP write path. Advocate hero images
// come from the public /api/advocates/:slug/photo route.
//
// One happy-path assertion per surface, matching this tier's philosophy:
//   /            homepage right-gutter hotspot → hover pops the clue out
//   /ai/         hero peeks from the bottom edge (bottom-pop overlay)
//   /api-docs/   embedded clue block at the bottom of the article
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// The consent banner is a full-viewport overlay on DEV/PROD that intercepts
// pointer events; remove it so the hover interaction can be exercised.
async function dismissConsent(page) {
  await page.evaluate(() => {
    ['#consent_blackbar', '#trustarc-banner-overlay', '#truste-consent-track', '.truste_overlay']
      .forEach((s) => document.querySelectorAll(s).forEach((n) => n.remove()));
  });
}

describe.skipIf(!hasBaseUrl())('e2e: Devtoberfest scavenger hunt (unauthenticated)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('homepage hotspot pops the clue out on hover', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const hotspot = page.locator('.sh--home .sh-hotspot');
      await hotspot.waitFor({ state: 'attached', timeout: 15_000 });

      const reveal = page.locator('.sh--home .sh-reveal');
      // Hidden until hovered.
      expect(await reveal.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

      await dismissConsent(page);
      const box = await hotspot.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // Wait for the CSS transition to complete.
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.sh--home .sh-reveal')).opacity === '1',
        undefined,
        { timeout: 5_000 }
      );

      expect(await page.locator('.sh--home .sh-clue-text').textContent()).toContain('1st letter of first name');
      expect(await page.locator('.sh--home .sh-moreinfo a').getAttribute('href')).toBe('https://url.sap/7afji2');
      // Advocate hero actually loaded from /api/advocates/:slug/photo.
      const imgOk = await page.locator('.sh--home .sh-img').evaluate((el) => el.complete && el.naturalWidth > 0);
      expect(imgOk, 'homepage advocate hero image failed to load').toBe(true);
    } finally {
      await context.close();
    }
  });

  it('/ai/ renders the DJ bottom-pop clue', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/ai/', { waitUntil: 'domcontentloaded' });
      const clue = page.locator('.sh--ai');
      await clue.waitFor({ state: 'attached', timeout: 15_000 });
      expect(await page.locator('.sh--ai .sh-clue-text').textContent()).toContain(
        'Congrats! We hope finding DJ'
      );
      const imgOk = await page.locator('.sh--ai .sh-img').evaluate((el) => el.complete && el.naturalWidth > 0);
      expect(imgOk, '/ai/ advocate hero image failed to load').toBe(true);
    } finally {
      await context.close();
    }
  });

  it('/api-docs/ embeds the scavenger-hunt block at the bottom', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/api-docs/', { waitUntil: 'domcontentloaded' });
      const block = page.locator('.sh--embed');
      await block.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await block.locator('.sh-heading').textContent()).toContain('Devtoberfest Scavenger Hunt');
      expect(await block.locator('.sh-clue-text').textContent()).toContain('4th letter of first name');
      const imgOk = await block.locator('.sh-img').evaluate((el) => el.complete && el.naturalWidth > 0);
      expect(imgOk, '/api-docs/ advocate hero image failed to load').toBe(true);
    } finally {
      await context.close();
    }
  });
});
