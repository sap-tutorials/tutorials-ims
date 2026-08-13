// e2e: FOUCE cloak on tutorial pages (#1688).
// Path: browser → approuter /tutorials/:slug → served HTML with the
// html[data-ui5-cloak] pre-paint gate (head.html) + ui5-overrides.css cloak.
//
// The bug: before the ui5.sap.com/ui5-bootstrap bundle calls
// customElements.define(), every un-upgraded ui5-* element paints its slotted
// light-DOM as raw text — the shellbar's nav/share/account popovers dump their
// full contents inline, pushing the page down, then collapse on hydration
// ("flash then rebuild"). The fix cloaks un-upgraded chrome until it upgrades.
//
// This spec asserts BOTH halves of the guarantee against a DEPLOYED env:
//   1. Pre-hydration (UI5 bundle blocked): the popovers are display:none (raw
//      dump gone) and the shellbar is visibility:hidden, while the readable
//      <main>/<h1> body stays visible.
//   2. Hydrated (bundle allowed): the shellbar upgrades and becomes visible —
//      i.e. the cloak LIFTS and never strands the chrome hidden.
//
// Anonymous — runs with just PLAYWRIGHT_BASE_URL, no credentials. Self-skips
// (no output) when the base URL is absent, so `npm test` is unaffected.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'abap-cloud-ui-from-interface';

// Everything that upgrades ui5-* elements. Aborting these reproduces the
// pre-hydration paint. The local bundle name is fingerprinted on deployed envs
// (ui5-bootstrap.<hash>.js) — the glob covers that and the bare dev name.
async function blockUi5(page) {
  await page.route('**/ui5.sap.com/**', (r) => r.abort());
  await page.route('**/ui5-bootstrap*', (r) => r.abort());
}

describe.skipIf(!hasBaseUrl())('e2e: FOUCE cloak (unauthenticated)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('cloaks un-upgraded chrome pre-hydration while the body stays visible', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await blockUi5(page);
      const response = await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()}`).toBe(200);

      // The pre-paint gate must have set the cloak attribute (non-preview build).
      await page.locator('html[data-ui5-cloak]').waitFor({ state: 'attached', timeout: 10_000 });

      const probe = await page.evaluate(() => {
        const cs = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const s = getComputedStyle(el);
          return { defined: el.matches(':defined'), display: s.display, visibility: s.visibility };
        };
        return {
          hasCloak: document.documentElement.hasAttribute('data-ui5-cloak'),
          navPopover: cs('#sb-nav-popover'),
          sharePopover: cs('#sb-share-popover'),
          shellbar: cs('#app-shellbar'),
          mainVisible: !!document.querySelector('main') &&
            getComputedStyle(document.querySelector('main')).visibility === 'visible',
          h1Count: document.querySelectorAll('h1').length,
        };
      });

      expect(probe.hasCloak, 'data-ui5-cloak must be set pre-hydration').toBe(true);
      // Un-upgraded popovers must NOT dump their content in flow.
      expect(probe.navPopover, '#sb-nav-popover missing').not.toBeNull();
      expect(probe.navPopover.defined, 'popover should be un-upgraded (UI5 blocked)').toBe(false);
      expect(probe.navPopover.display, 'un-upgraded nav popover must be display:none').toBe('none');
      expect(probe.sharePopover?.display, 'un-upgraded share popover must be display:none').toBe('none');
      // Chrome bar is hidden but reserves its box (visibility, not display).
      expect(probe.shellbar?.visibility, 'un-upgraded shellbar must be visibility:hidden').toBe('hidden');
      // The readable content is never cloaked.
      expect(probe.mainVisible, 'tutorial body <main> must stay visible').toBe(true);
      expect(probe.h1Count, 'tutorial should render a heading').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('lifts the cloak once UI5 upgrades (chrome is not permanently hidden)', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // No blocking — the real bundle loads and upgrades the shellbar.
      await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      const shellbar = page.locator('#app-shellbar');
      await shellbar.waitFor({ state: 'attached', timeout: 15_000 });
      // Wait for the custom element to upgrade, then assert it is visible.
      await page.waitForFunction(
        () => document.querySelector('#app-shellbar')?.matches(':defined') === true,
        { timeout: 20_000 },
      );
      const visibility = await shellbar.evaluate((el) => getComputedStyle(el).visibility);
      expect(visibility, 'shellbar must be visible after it upgrades').toBe('visible');
    } finally {
      await context.close();
    }
  });
});
