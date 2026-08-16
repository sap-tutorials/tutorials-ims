// e2e: tutorial page renders correctly at a phone viewport (issue #1803).
// Anonymous, like tutorial-serve.test.js. Guards two mobile regressions:
//   1. No horizontal overflow — the .op-twocol grid must stay within the
//      viewport (it collapses to a single minmax(0,1fr) track ≤960px). A bare
//      `1fr` track lets a wide min-content child (touch-mode ui5-wizard, card
//      rails) blow the column out, expanding the mobile layout viewport and
//      scrolling the page sideways.
//   2. The mobile "Steps" FAB (#op-mobile-fab) must clear the fixed prev/next
//      bar (.tutorial-stepnav) instead of sitting on top of its "Next" pill.
//
// SLUG: 'cap-add-mcp-capabilities' is a 7-step grouped tutorial — the exact page
// from the bug report and the one that overflows without the fix (wide wizard).
// If it 404s, swap for another multi-step grouped tutorial (≥3 steps + prev/next).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright-core';
import { BASE_URL, hasBaseUrl } from './e2e.config.js';

const SLUG = 'cap-add-mcp-capabilities';
// Emulate a Pixel-class phone: device-width 412 CSS px, touch + mobile so UI5
// components render their touch-size variants (the trigger for the overflow).
const DEVICE = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125 Mobile Safari/537.36',
};

describe.skipIf(!hasBaseUrl())('e2e: tutorial mobile layout (issue #1803)', () => {
  let browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('renders a phone-width tutorial without horizontal overflow or FAB overlap', async () => {
    const context = await browser.newContext({ baseURL: BASE_URL, ...DEVICE });
    const page = await context.newPage();
    try {
      const response = await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status for /tutorials/${SLUG}`).toBe(200);
      // Wait for the object-page layout + let islands (wizard, group-nav) hydrate.
      await page.locator('.op-page').first().waitFor({ state: 'attached', timeout: 20_000 });
      await page.waitForTimeout(4_000);

      const m = await page.evaluate(() => {
        const body = document.querySelector('.op-body');
        const fab = document.querySelector('#op-mobile-fab');
        const bar = document.querySelector('.tutorial-stepnav');
        const fr = fab ? fab.getBoundingClientRect() : null;
        const br = bar ? bar.getBoundingClientRect() : null;
        return {
          innerWidth: window.innerWidth,
          bodyScrollWidth: body ? body.scrollWidth : null,
          bodyClientWidth: body ? body.clientWidth : null,
          hasBar: !!bar,
          fabTop: fr ? fr.top : null,
          fabBottom: fr ? fr.bottom : null,
          barTop: br ? br.top : null,
          barBottom: br ? br.bottom : null,
        };
      });

      // (1) No horizontal overflow. On a mobile context an overflowing page
      // expands window.innerWidth beyond the device width (e.g. 412 → 541), and
      // the content region's scrollWidth exceeds its clientWidth.
      expect(m.bodyScrollWidth, 'content region overflows horizontally').toBeLessThanOrEqual(
        m.bodyClientWidth + 2
      );
      expect(m.innerWidth, 'mobile layout viewport expanded past device width').toBeLessThanOrEqual(
        DEVICE.viewport.width + 2
      );

      // (2) When the fixed prev/next bar is present, the Steps FAB must sit above
      // it (no vertical overlap). Skip if this tutorial has no group nav bar.
      if (m.hasBar && m.fabBottom != null && m.barTop != null) {
        expect(
          m.fabBottom,
          'Steps FAB overlaps the sticky prev/next bar (bug #1803)'
        ).toBeLessThanOrEqual(m.barTop);
      }
    } finally {
      await context.close();
    }
  });
});
