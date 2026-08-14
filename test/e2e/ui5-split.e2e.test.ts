// e2e: per-page-type runtime verification of the UI5 code-split (#1777 Task 8).
//
// Checks — for each page type — that:
//   1. Key ui5-* elements upgrade (:defined) after the split entries load.
//   2. The SAP Horizon theme is applied (--sapBackgroundColor non-empty).
//   3. The FOUCE cloak (data-ui5-cloak) is cleared within 12 s.
//   4. No UI5 / theme / CLDR console errors are emitted.
//   5. The split IS splitting: page-type entry bundles load only on the right
//      pages (request-log assertions — mustLoad / mustNotLoad).
//
// Self-skips (no output, no browser) when PLAYWRIGHT_BASE_URL / SMOKE_BASE_URL
// is absent — so `npm test` (unit suite) is never affected.
//
// Run against a local static build with the flag ON:
//   PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> \
//   npx vitest run --project e2e test/e2e/ui5-split.e2e.test.ts
//
// Build steps (one-time, idempotent):
//   npm run build:apps && npm run build:island-manifest
//   HUGO_PARAMS_UI5SPLIT=true hugo --source hugo --minify
//
// Note: island/API calls (e.g. /api/*, /homepage/*) will 404 against a bare
// static server — that is expected dev noise. The console-error filter targets
// only UI5/theme/CLDR errors, NOT those 404s.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright-core';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// Tutorial slug that contains ui5-wizard + ui5-tabcontainer in its static HTML.
// If this slug ever loses the wizard/tabcontainer shortcodes, the slugGuardTags
// assertion below will fail loudly rather than silently weakening the suite.
const TUTORIAL_SLUG = 'cap-status-transition-flows';

interface PageSpec {
  label: string;
  url: string;
  /** Custom-element tag names that MUST be :defined after the split entries load. */
  mustUpgrade: string[];
  /**
   * Request URL patterns that MUST appear in the network log — confirms the
   * page-type entry bundle actually loaded (positive split check).
   */
  mustLoad?: RegExp[];
  /**
   * Request URL patterns that must NOT appear — confirms the split is not
   * over-loading page-type bundles onto pages that don't need them.
   */
  mustNotLoad?: RegExp[];
  /**
   * At least one of these tags must be present in the DOM (not count===0).
   * Guards against the fixture slug drifting: if every tag silently skips
   * because count===0 the page-specific assertions evaporate.
   */
  slugGuardTags?: string[];
}

const PAGE_SPECS: PageSpec[] = [
  {
    label: 'homepage (/)',
    url: '/',
    // Homepage loads only ui5-core; shellbar must upgrade.
    mustUpgrade: ['ui5-shellbar'],
    // ui5-core IS expected; page-type bundles must NOT load on the homepage.
    mustLoad: [/ui5-core-[^/]+\.js/],
    mustNotLoad: [/ui5-tutorial-[^/]+\.js/, /ui5-me-[^/]+\.js/],
  },
  {
    label: `tutorial page (/tutorials/${TUTORIAL_SLUG}/)`,
    url: `/tutorials/${TUTORIAL_SLUG}/`,
    // Tutorial pages load ui5-core + ui5-tutorial; wizard and tabcontainer
    // are present in cap-status-transition-flows static HTML.
    mustUpgrade: ['ui5-shellbar', 'ui5-wizard', 'ui5-tabcontainer'],
    // ui5-tutorial MUST load on a tutorial page (positive split confirmation).
    mustLoad: [/ui5-core-[^/]+\.js/, /ui5-tutorial-[^/]+\.js/],
    mustNotLoad: [/ui5-me-[^/]+\.js/],
    // Guard: if neither wizard nor tabcontainer is in the DOM the fixture has
    // drifted and the page-specific upgrade checks evaporate silently.
    slugGuardTags: ['ui5-wizard', 'ui5-tabcontainer'],
  },
  {
    label: 'me page (/me/)',
    url: '/me/',
    // /me/ loads ui5-core + ui5-me; shellbar must upgrade.
    mustUpgrade: ['ui5-shellbar'],
    mustLoad: [/ui5-core-[^/]+\.js/, /ui5-me-[^/]+\.js/],
    mustNotLoad: [/ui5-tutorial-[^/]+\.js/],
  },
];

describe.skipIf(!hasBaseUrl())('e2e: UI5 split — per-page-type upgrade + theme + cloak', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const spec of PAGE_SPECS) {
    it(`${spec.label}: elements upgrade, theme applied, cloak cleared, no UI5 errors`, async () => {
      const { context, page } = await newPage(browser, { authenticated: false });
      const consoleErrors: string[] = [];
      const requestUrls: string[] = [];

      page.on('console', (m: { type(): string; text(): string }) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      // Register BEFORE goto so we capture every request from the initial load.
      page.on('request', (r: { url(): string }) => requestUrls.push(r.url()));

      try {
        await page.goto(spec.url, { waitUntil: 'load' });

        // --- 1. Each required custom element must upgrade (:defined) ---
        for (const tag of spec.mustUpgrade) {
          // Skip if the element is genuinely absent in the static page (not
          // a split defect, e.g. ui5-wizard only present on tutorials with
          // wizard shortcode). If it IS in the DOM it MUST upgrade.
          const count = await page.locator(tag).count();
          if (count === 0) continue;

          // Wait for the element to be registered by the UI5 bundle.
          await page.waitForFunction(
            (t: string) => {
              const el = document.querySelector(t);
              return el == null || el.matches(':defined');
            },
            tag,
            { timeout: 20_000 },
          );

          const isDefined: boolean = await page.evaluate(
            (t: string) => {
              const el = document.querySelector(t);
              return el == null || el.matches(':defined');
            },
            tag,
          );
          expect(
            isDefined,
            `<${tag}> on ${spec.url} must be :defined after the split bundle loads`,
          ).toBe(true);
        }

        // --- 1b. Slug-guard: fixture must not silently evaporate ---
        // If every tag in slugGuardTags has count===0 the upgrade assertions
        // above all skipped — the test was only checking ui5-shellbar (same as
        // homepage) and gave no real tutorial-specific coverage. Fail loudly.
        if (spec.slugGuardTags && spec.slugGuardTags.length > 0) {
          const guardCounts = await Promise.all(
            spec.slugGuardTags.map((t) => page.locator(t).count()),
          );
          const anyPresent = guardCounts.some((c) => c > 0);
          expect(
            anyPresent,
            `Fixture drift on ${spec.url}: none of [${spec.slugGuardTags.join(', ')}] ` +
              `were found in the DOM. Update TUTORIAL_SLUG to a slug that renders ` +
              `these elements so the tutorial-specific upgrade checks don't silently skip.`,
          ).toBe(true);
        }

        // --- 2. SAP Horizon theme applied (CSS custom property non-empty) ---
        const bg: string = await page.evaluate(
          () =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--sapBackgroundColor')
              .trim(),
        );
        expect(
          bg.length,
          `--sapBackgroundColor must be non-empty on ${spec.url} (theme not applied)`,
        ).toBeGreaterThan(0);

        // --- 3. FOUCE cloak attribute cleared ---
        // head.html sets data-ui5-cloak pre-paint; a DOMContentLoaded+8 s
        // timeout removes it. waitForFunction polls until it's gone (≤ 12 s).
        await page.waitForFunction(
          () => !document.documentElement.hasAttribute('data-ui5-cloak'),
          { timeout: 12_000 },
        );
        const cloakGone: boolean = await page.evaluate(
          () => !document.documentElement.hasAttribute('data-ui5-cloak'),
        );
        expect(cloakGone, `data-ui5-cloak must be cleared on ${spec.url}`).toBe(true);

        // --- 4. No UI5 / theme / CLDR console errors ---
        // Dev-noise 404s (/api/*, /homepage/*) on a static server are expected
        // and are intentionally NOT matched by this filter.
        const ui5Errors = consoleErrors.filter((e) =>
          /ui5|theme|cldr|not registered|customElement/i.test(e),
        );
        expect(
          ui5Errors,
          `UI5/theme/CLDR console errors on ${spec.url}:\n${ui5Errors.join('\n')}`,
        ).toHaveLength(0);

        // --- 5. Request-log: the split IS splitting ---
        // Guard: only enforce when the split flag is ON (ui5-core-*.js loaded).
        // On flag-OFF envs the page loads the monolith (ui5-bootstrap.js) instead
        // of the split entries; mustLoad patterns like /ui5-core-*/ would false-fail.
        // Detect flag state by checking which top-level UI5 bundle was requested.
        const flagOff = requestUrls.some((u) => /\/js\/ui5-bootstrap\.js/.test(u));
        if (!flagOff) {
          // mustLoad: every pattern must match at least one captured request URL.
          for (const pattern of spec.mustLoad ?? []) {
            const matched = requestUrls.some((u) => pattern.test(u));
            expect(
              matched,
              `Expected a request matching ${pattern} on ${spec.url} but none found.\n` +
                `Captured JS requests: ${requestUrls.filter((u) => u.endsWith('.js')).join(', ')}`,
            ).toBe(true);
          }
          // mustNotLoad: no captured request URL may match.
          for (const pattern of spec.mustNotLoad ?? []) {
            const offender = requestUrls.find((u) => pattern.test(u));
            expect(
              offender,
              `Unexpected request matching ${pattern} on ${spec.url} — ` +
                `the split is over-loading a page-type bundle onto this page: ${offender}`,
            ).toBeUndefined();
          }
        }
      } finally {
        await context.close();
      }
    });
  }
});
