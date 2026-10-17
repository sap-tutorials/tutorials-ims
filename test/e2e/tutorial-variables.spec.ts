// e2e: tutorial-variables live substitution + persistence (#2811).
//
// Verifies the end-to-end feature against a deployed tutorial that declares a
// `groupNumber` variable:
//  - the variables input panel is present on the tutorial page
//  - typing a value substitutes EVERY occurrence in prose, inline code, AND
//    fenced code blocks (the three rendering contexts that exercise the full
//    wrapping pipeline)
//  - the value survives a browser reload (localStorage persistence)
//  - (skipped with TODO) carry-over to a sibling tutorial in the same mission
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so `npm test`
// (unit suite) and credential-less local runs are unaffected. Runs anonymously —
// the variables feature is public (no XSUAA on /tutorials/*).
//
// SLUG: update this to the first production tutorial that declares `groupNumber`
// once the tutorial is rebuilt with the feature enabled (initial target:
// teched2026-da164-ex0 or equivalent — see spec
// docs/superpowers/specs/2026-10-17-tutorial-variables-design.md).
//
// MISSION_SLUG + SIBLING_SLUG: update once a two-tutorial mission that declares
// `groupNumber` is deployed. Until then the carry-over test is .skip'd with a
// TODO referencing this comment.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// ---------------------------------------------------------------------------
// Fixture constants — update these once a real tutorial with `groupNumber` is
// published (rebuilt with the feature enabled).
// ---------------------------------------------------------------------------

/** A tutorial that declares `groupNumber` in its `variables:` frontmatter. */
const SLUG = 'teched2026-da164-ex0';

/** The path as served by the approuter → CAP content-serve pipeline. */
const TUTORIAL_PATH = `/tutorials/${SLUG}/`;

/**
 * Mission slug that contains `SLUG` AND at least one other tutorial that also
 * declares `groupNumber`. Used only by the carry-over test below.
 * Set to a non-empty string once such a mission exists on the deployed target.
 */
const MISSION_SLUG = ''; // TODO: populate once a qualifying mission is deployed

/**
 * A sibling tutorial in MISSION_SLUG that also declares `groupNumber`.
 * Used only by the carry-over test. Must differ from SLUG.
 */
const SIBLING_SLUG = ''; // TODO: populate once a qualifying mission is deployed

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// (waitForIsland is inlined at each call site as waitForSelector('#tv-input-groupNumber')).

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasBaseUrl())('e2e: tutorial-variables live substitution (#2811)', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  // -------------------------------------------------------------------------
  // 1. Panel presence
  // -------------------------------------------------------------------------

  it('the variables input panel is present on a tutorial that declares variables', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.addInitScript(() => localStorage.clear());
      const response = await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      expect(
        response?.status(),
        `unexpected HTTP status for ${TUTORIAL_PATH}`,
      ).toBe(200);

      // The mount div is always in the DOM when `.Params.variables` is non-empty
      // (rendered by the Hugo layout). The island mounts asynchronously.
      const panel = await page.waitForSelector('#tutorial-variables-panel', { timeout: 10_000 });
      expect(panel, 'tutorial-variables-panel mount div should be present').toBeTruthy();

      // The island should render at least one labelled input for `groupNumber`.
      const input = await page.waitForSelector('#tv-input-groupNumber', { timeout: 10_000 });
      expect(input, 'tv-input-groupNumber should be rendered by the island').toBeTruthy();
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Live substitution — prose, inline code, AND fenced code
  // -------------------------------------------------------------------------

  it('typing a value substitutes spans in prose, inline-code, and fenced-code contexts', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tv-input-groupNumber', { timeout: 10_000 });

      // Type the test value.
      await page.fill('#tv-input-groupNumber', '007');

      // Give the reactive update a tick to propagate.
      await page.waitForFunction(
        () => {
          const spans = document.querySelectorAll('[data-tut-var="groupNumber"]');
          return spans.length > 0 && [...spans].some((el) => el.textContent === '007');
        },
        { timeout: 5_000 },
      );

      // Collect ALL [data-tut-var="groupNumber"] spans and their contexts.
      const result = await page.evaluate(() => {
        const spans = [...document.querySelectorAll<HTMLElement>('[data-tut-var="groupNumber"]')];
        return spans.map((el) => {
          // Walk up to find the nearest block context:
          // - inside <pre><code> → fenced code
          // - inside <code> (but not <pre>) → inline code
          // - elsewhere → prose
          let node: Element | null = el;
          let inPre = false;
          let inInlineCode = false;
          while (node) {
            if (node.tagName === 'PRE') { inPre = true; break; }
            if (node.tagName === 'CODE') { inInlineCode = true; /* keep walking to detect <pre> */ }
            node = node.parentElement;
          }
          return {
            text: el.textContent,
            context: inPre ? 'fenced' : inInlineCode ? 'inline-code' : 'prose',
          };
        });
      });

      // There must be at least one occurrence in each of the three contexts.
      const texts = result.map((r) => r.text);
      expect(texts.every((t) => t === '007'), `all spans should read "007", got: ${JSON.stringify(texts)}`).toBe(true);

      const contexts = new Set(result.map((r) => r.context));
      expect(
        contexts.has('prose'),
        `expected a prose occurrence of [data-tut-var="groupNumber"]; contexts found: ${[...contexts]}`,
      ).toBe(true);
      expect(
        contexts.has('inline-code'),
        `expected an inline-code occurrence; contexts found: ${[...contexts]}`,
      ).toBe(true);
      expect(
        contexts.has('fenced'),
        `expected a fenced-code occurrence (inside <pre>); contexts found: ${[...contexts]}`,
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // 3. localStorage persistence across reload
  // -------------------------------------------------------------------------

  it('the typed value persists across a browser reload', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tv-input-groupNumber', { timeout: 10_000 });

      // Type and wait for substitution.
      await page.fill('#tv-input-groupNumber', '007');
      await page.waitForFunction(
        () => {
          const spans = document.querySelectorAll('[data-tut-var="groupNumber"]');
          return spans.length > 0 && [...spans].some((el) => el.textContent === '007');
        },
        { timeout: 5_000 },
      );

      // Reload the page (same context = same localStorage origin).
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tv-input-groupNumber', { timeout: 10_000 });

      // The island's onMounted restores from localStorage before rendering;
      // wait for the substitution to re-apply.
      await page.waitForFunction(
        () => {
          const spans = document.querySelectorAll('[data-tut-var="groupNumber"]');
          return spans.length > 0 && [...spans].some((el) => el.textContent === '007');
        },
        { timeout: 5_000 },
      );

      // Verify the input itself reflects the stored value.
      const inputValue = await page.inputValue('#tv-input-groupNumber');
      expect(inputValue, 'input should show the persisted value after reload').toBe('007');

      // Verify at least one substituted span still reads "007".
      const spanText = await page.evaluate(() => {
        const span = document.querySelector<HTMLElement>('[data-tut-var="groupNumber"]');
        return span?.textContent ?? null;
      });
      expect(spanText, 'a span should still show "007" after reload').toBe('007');
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Mission carry-over (skipped until fixture is available)
  //
  // TODO: Once a two-tutorial mission that declares `groupNumber` is deployed,
  // populate MISSION_SLUG and SIBLING_SLUG above, then remove the .skip.
  //
  // Intended assertion:
  //   1. load SLUG, type "007" → the island writes to both the tutorial key
  //      (`tutvar:<SLUG>:groupNumber`) AND the mission key
  //      (`tutvar:<MISSION_SLUG>:groupNumber`) in localStorage.
  //   2. navigate to SIBLING_SLUG (same mission) → the island reads the mission
  //      key on mount and pre-fills the input with "007".
  //
  // The carry-over is purely client-side (localStorage key sharing by mission
  // slug), so this test exercises the storage.ts writeValue/readValue logic
  // against a deployed page rather than a unit mock.
  // -------------------------------------------------------------------------

  it.skip('value carries over to a sibling tutorial in the same mission', async () => {
    // TODO(#2811): Remove this skip once MISSION_SLUG and SIBLING_SLUG are set.
    if (!MISSION_SLUG || !SIBLING_SLUG) {
      throw new Error(
        'Set MISSION_SLUG and SIBLING_SLUG in this spec file to enable the carry-over test.',
      );
    }

    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.addInitScript(() => localStorage.clear());

      // Step 1: load the first tutorial, type "007".
      await page.goto(`/tutorials/${SLUG}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tv-input-groupNumber', { timeout: 10_000 });
      await page.fill('#tv-input-groupNumber', '007');
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-tut-var="groupNumber"]')].some(
            (el) => el.textContent === '007',
          ),
        { timeout: 5_000 },
      );

      // Step 2: navigate to the sibling tutorial.
      await page.goto(`/tutorials/${SIBLING_SLUG}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tv-input-groupNumber', { timeout: 10_000 });

      // Step 3: the island should pre-fill from the shared mission key.
      await page.waitForFunction(
        () =>
          (document.querySelector('#tv-input-groupNumber') as HTMLInputElement | null)?.value ===
          '007',
        { timeout: 5_000 },
      );

      const inputValue = await page.inputValue('#tv-input-groupNumber');
      expect(inputValue, 'sibling tutorial input should be pre-filled via mission carry-over').toBe(
        '007',
      );
    } finally {
      await context.close();
    }
  });
});
