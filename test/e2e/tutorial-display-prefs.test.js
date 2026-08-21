// e2e: tutorial display preferences (#1966).
//
// Drives the real popover + localStorage path against a deployed tutorial page:
//  - toggling the header to "Compact" hides the description/chip row and sets
//    data-tut-header="thinbar"
//  - a short viewport (height < 900) with no explicit pref auto-applies thinbar
//  - an explicit "Locked" pref overrides the short-viewport default
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so `npm test`
// (unit suite) is unaffected. Runs anonymously.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// Reuse the slug from tutorial-serve.test.js — a known-good, stable tutorial
// used across multiple e2e specs.
const SLUG = 'abap-cloud-ui-from-interface';
const TUTORIAL_PATH = `/tutorials/${SLUG}/`;

describe.skipIf(!hasBaseUrl())('e2e: tutorial display prefs (#1966)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('short viewport auto-applies compact header when no explicit pref', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1280, height: 700 });
      // Seed before navigation so the init script fires before page scripts.
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
      const mode = await page.evaluate(
        () => document.documentElement.getAttribute('data-tut-header'),
      );
      expect(mode).toBe('thinbar');
    } finally {
      await context.close();
    }
  });

  it('explicit Locked pref overrides the short-viewport default', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1280, height: 700 });
      // Pre-seed the pref before the page loads so init script fires first.
      await page.addInitScript(() => localStorage.setItem('tut.pref.header', 'locked'));
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
      const mode = await page.evaluate(
        () => document.documentElement.getAttribute('data-tut-header'),
      );
      expect(mode).toBe('locked');
    } finally {
      await context.close();
    }
  });

  it('toggling header to Compact hides description + chips', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      // Tall viewport with no pref → locked mode, chips visible.
      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-tut-header')),
        'tall viewport should start in locked mode',
      ).toBe('locked');

      // Open the display-prefs popover and switch to Compact (thinbar).
      await page.click('#sb-prefs');
      await page.click('ui5-segmented-button-item[data-mode="thinbar"]');

      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-tut-header')),
        'attribute should update to thinbar after clicking Compact',
      ).toBe('thinbar');

      const chipsHidden = await page.evaluate(() => {
        const chips = document.querySelector('.op-header__chips');
        return !chips || getComputedStyle(chips).display === 'none';
      });
      expect(chipsHidden, '.op-header__chips should be hidden in thinbar mode').toBe(true);
    } finally {
      await context.close();
    }
  });
});
