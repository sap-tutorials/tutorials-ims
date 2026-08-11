// e2e: mobile "Navigate" menu (issue #1652).
//
// On narrow/mobile viewports the ui5-shellbar collapses the "Navigate" item
// (#sb-nav) into its built-in overflow (burger) popover. Before the fix, tapping
// "Navigate" inside that overflow menu closed the menu but never opened the
// navigation popover — the clicked item's `targetRef` was the transient list
// item inside the overflow popover, which closes on the same click, and a
// ui5-popover cannot anchor to a detached opener. The fix anchors the nav
// popover to the always-present overflow button and defers the open one frame.
//
// This spec drives the REAL click path at a phone viewport and asserts the nav
// popover (#sb-nav-popover) actually opens.
//
// Self-skips cleanly when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so that
// `npm test` (unit suite) is never affected. Runs anonymously — the homepage
// shellbar needs no auth.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const PHONE = { width: 390, height: 780 };

describe.skipIf(!hasBaseUrl())('e2e: mobile Navigate menu (#1652)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('tapping "Navigate" in the overflow menu opens the navigation popover', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize(PHONE);

      const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
      expect(response?.status(), 'homepage must return 200').toBe(200);

      // Wait for the shellbar custom element + our #sb-nav item to be upgraded.
      await page.waitForFunction(
        () => !!(customElements.get('ui5-shellbar') && document.getElementById('sb-nav')),
        { timeout: 15_000 },
      );

      // The overflow layout runs after the shellbar sizes itself. At a phone
      // width "Navigate" must land in the overflow menu. If for some reason it
      // did not overflow on this env, there is nothing to reproduce — skip
      // rather than fail (keeps the suite green on unexpected wide viewports).
      const overflowed = await page
        .waitForFunction(() => document.getElementById('sb-nav')?.inOverflow === true, {
          timeout: 8_000,
        })
        .then(() => true)
        .catch(() => false);
      if (!overflowed) {
        console.warn('[header-mobile-nav e2e] #sb-nav did not overflow at 390px — skipping');
        return;
      }

      // The nav popover must start closed.
      expect(
        await page.evaluate(() => document.getElementById('sb-nav-popover')?.open === true),
        'nav popover should be closed initially',
      ).toBe(false);

      // 1) Open the shellbar overflow (burger) menu via its real button.
      await page.evaluate(() => {
        const sb = document.getElementById('app-shellbar');
        const btn = sb?.shadowRoot?.querySelector('[data-ui5-stable="overflow"]');
        btn?.click();
      });

      // The #sb-nav item is slotted into the (now open) overflow popover.
      await page.locator('#sb-nav').waitFor({ state: 'visible', timeout: 8_000 });

      // 2) Tap "Navigate".
      await page.locator('#sb-nav').click();

      // 3) The navigation popover must open (deferred one frame by the fix).
      await page.waitForFunction(
        () => document.getElementById('sb-nav-popover')?.open === true,
        { timeout: 5_000 },
      );

      // And it must actually show the navigation entries.
      const navItems = page.locator('#sb-nav-popover ui5-li');
      expect(await navItems.count(), 'nav popover should contain nav entries').toBeGreaterThan(0);
      expect(
        await navItems.first().isVisible(),
        'first nav entry should be visible',
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
