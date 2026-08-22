// e2e: the tutorial navigator must not shift its card grid when the Vue island
// mounts (option 1a — SSR the hero/search/filter/toolbar chrome).
//
// The bug: /tutorial-navigator server-renders ONLY the 24-card preview grid at
// the top of #tutorial-navigator. When navigator-<hash>.js loads, Vue mounts
// and renders the full app — hero + search box + open filter panel + toolbar —
// ABOVE the grid, shoving the first card down (measured live on DEV: first-card
// top 120px pre-mount -> 792px mounted on desktop, 120 -> 1554 on mobile). That
// ~670–1430px jump is the visible flash.
//
// The fix SSRs the same chrome (styled by render-blocking home.css, not the
// Vue-bundle scoped CSS) so the grid sits at its final offset from first paint.
// Vue then replaces the container with an identically-laid-out tree — no shift.
//
// This spec asserts the invariant directly, against a DEPLOYED env: the top of
// the first tutorial card is the same (within tolerance) whether the navigator
// island is BLOCKED (SSR-only paint, what a crawler / pre-mount human sees) or
// ALLOWED to mount — at both desktop and mobile widths.
//
// Anonymous — needs only PLAYWRIGHT_BASE_URL, no credentials. Self-skips (no
// output) when the base URL is absent, so `npm test` is unaffected.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const PATH = '/tutorial-navigator';
// The grid may reflow by a hair as fonts settle; a real fix collapses the
// jump from ~670px to sub-pixel, so a small tolerance still fails hard on the
// bug while tolerating font/scrollbar noise.
const TOLERANCE_PX = 8;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 800 },
];

// First tutorial/mission/group card link inside the navigator container. Present
// in BOTH the SSR preview grid and the Vue-rendered result area, so its top is
// the apples-to-apples "where does the grid start" metric across both states.
const FIRST_CARD = '#tutorial-navigator a[href*="/tutorials/"]';
// Vue-only marker: the SSR preview uses .navigator-grid--ssr-preview; the mounted
// app renders .navigator-result-area. Waiting on it confirms the island mounted.
const MOUNTED_MARKER = '.navigator-result-area';

async function firstCardTop(page) {
  await page.locator(FIRST_CARD).first().waitFor({ state: 'visible', timeout: 15_000 });
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().top) : null;
  }, FIRST_CARD);
}

describe.skipIf(!hasBaseUrl())('e2e: navigator has no card-grid shift on mount', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const vp of VIEWPORTS) {
    it(`first card sits at the same top pre-mount and mounted (${vp.name})`, async () => {
      // --- SSR paint: block the navigator island so nothing mounts.
      const ssr = await newPage(browser, { authenticated: false });
      let ssrTop;
      try {
        await ssr.page.setViewportSize({ width: vp.width, height: vp.height });
        await ssr.page.route('**/js/navigator-*.js', (r) => r.abort());
        const resp = await ssr.page.goto(PATH, { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), `SSR nav returned ${resp?.status()}`).toBe(200);
        ssrTop = await firstCardTop(ssr.page);
      } finally {
        await ssr.context.close();
      }

      // --- Mounted: allow the island; wait until the Vue result area renders.
      const live = await newPage(browser, { authenticated: false });
      let mountedTop;
      try {
        await live.page.setViewportSize({ width: vp.width, height: vp.height });
        await live.page.goto(PATH, { waitUntil: 'domcontentloaded' });
        await live.page.locator(MOUNTED_MARKER).first().waitFor({ state: 'attached', timeout: 15_000 });
        // let the mounted layout settle (fonts, facet enrichment fetch)
        await live.page.waitForTimeout(1_500);
        mountedTop = await firstCardTop(live.page);
      } finally {
        await live.context.close();
      }

      expect(ssrTop, 'no SSR first card').not.toBeNull();
      expect(mountedTop, 'no mounted first card').not.toBeNull();
      expect(
        Math.abs(ssrTop - mountedTop),
        `first-card top shifted on mount (${vp.name}): SSR=${ssrTop}px, mounted=${mountedTop}px`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }, 60_000);
  }
});
