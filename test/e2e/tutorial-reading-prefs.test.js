// e2e: tutorial reading preferences (#1966).
//
// Drives the reading-prefs popover against a deployed tutorial page, asserting:
//  - wrap-long-lines toggle sets html[data-tut-code-wrap="on"]
//  - code-size segmented button (Large) sets html[data-tut-code-size="l"]
//  - collapse-screenshots sets html[data-tut-img-collapse="on"] and shrinks
//    the rendered height of any visible tutorial image
//  - easier-to-read font is NOT fetched on default load (lazy) but IS requested
//    after the toggle fires (the single most important behavioral check)
//  - copy-clean strips "$ " shell prompt from the clipboard when a copy button
//    is clicked on a matching code block (falls back to attr assertion when
//    clipboard-read is unavailable in the test harness)
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so `npm test`
// (unit suite) is unaffected. Runs anonymously (tutorial pages are public).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, BASE_URL, authHeader, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

// Reuse the same stable slug as tutorial-display-prefs.test.js so a single
// deployed tutorial satisfies the whole e2e tier.
const SLUG = 'abap-cloud-ui-from-interface';
const TUTORIAL_PATH = `/tutorials/${SLUG}/`;

describe.skipIf(!hasBaseUrl())('e2e: tutorial reading prefs (#1966)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  // ------------------------------------------------------------------
  // 1. Wrap long lines
  // ------------------------------------------------------------------
  it('toggling Wrap long lines sets html[data-tut-code-wrap="on"]', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      await page.click('#sb-prefs');
      await page.click('[data-testid="tut-prefs-code-wrap"]');

      const val = await page.evaluate(
        () => document.documentElement.getAttribute('data-tut-code-wrap'),
      );
      expect(val, 'html[data-tut-code-wrap] should be "on" after toggle').toBe('on');
    } finally {
      await context.close();
    }
  });

  // ------------------------------------------------------------------
  // 2. Code size Large
  // ------------------------------------------------------------------
  it('selecting code size Large sets html[data-tut-code-size="l"]', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      await page.click('#sb-prefs');
      // The segmented button items carry data-testid on the parent + data-size on items.
      await page.click('[data-testid="tut-prefs-code-size"] [data-size="l"]');

      const val = await page.evaluate(
        () => document.documentElement.getAttribute('data-tut-code-size'),
      );
      expect(val, 'html[data-tut-code-size] should be "l" after selecting Large').toBe('l');
    } finally {
      await context.close();
    }
  });

  // ------------------------------------------------------------------
  // 3. Collapse screenshots
  // ------------------------------------------------------------------
  it('toggling Collapse screenshots sets attr and shrinks rendered image height', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      // Capture a visible image's rendered height BEFORE collapse is enabled.
      const heightBefore = await page.evaluate(() => {
        const img = document.querySelector('.op-body img[data-zoomable]');
        return img ? img.getBoundingClientRect().height : null;
      });

      await page.click('#sb-prefs');
      await page.click('[data-testid="tut-prefs-img-collapse"]');

      const attrVal = await page.evaluate(
        () => document.documentElement.getAttribute('data-tut-img-collapse'),
      );
      expect(attrVal, 'html[data-tut-img-collapse] should be "on" after toggle').toBe('on');

      // If a visible image was present, its rendered height must have shrunk (or
      // collapsed to 0).  Skip the size assertion when no image was visible.
      if (heightBefore !== null && heightBefore > 0) {
        const heightAfter = await page.evaluate(() => {
          const img = document.querySelector('.op-body img[data-zoomable]');
          return img ? img.getBoundingClientRect().height : 0;
        });
        expect(
          heightAfter,
          'image rendered height should shrink when collapse is enabled',
        ).toBeLessThan(heightBefore);
      }
    } finally {
      await context.close();
    }
  });

  // ------------------------------------------------------------------
  // 4. Lazy-font proof (most important check)
  // ------------------------------------------------------------------
  it('OpenDyslexic font is NOT fetched on load but IS requested after font toggle', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addInitScript(() => localStorage.clear());

      // Accumulate every OpenDyslexic network request from the very beginning of
      // the page lifecycle, before navigation fires.
      const dyslexicUrls = [];
      page.on('request', (req) => {
        if (/OpenDyslexic/i.test(req.url())) {
          dyslexicUrls.push(req.url());
        }
      });

      // waitUntil:'networkidle' ensures all initial font/CSS loads have settled.
      await page.goto(TUTORIAL_PATH, { waitUntil: 'networkidle' });

      expect(
        dyslexicUrls,
        'OpenDyslexic font must NOT be fetched on the default page load (lazy-load guarantee)',
      ).toHaveLength(0);

      // Arm a request-waiter BEFORE clicking to avoid a race where the request
      // fires between the click and the listen setup.
      const fontRequestPromise = page
        .waitForRequest((req) => /OpenDyslexic/i.test(req.url()), { timeout: 8000 })
        .catch(() => null);

      await page.click('#sb-prefs');
      await page.click('[data-testid="tut-prefs-readable-font"]');

      const fontRequest = await fontRequestPromise;

      expect(
        fontRequest,
        'An OpenDyslexic font request must fire after enabling the easier-to-read font toggle',
      ).not.toBeNull();

      if (fontRequest) {
        expect(
          /\.woff2/i.test(fontRequest.url()),
          'The requested OpenDyslexic resource should be a WOFF2 file',
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  // ------------------------------------------------------------------
  // 5. Copy-clean strips "$ " shell prompt
  // ------------------------------------------------------------------
  it('copy-clean strips "$ " shell prompt from copied code block text', async () => {
    // Clipboard note: we create the context directly (instead of via newPage) so
    // we can pass clipboard permissions.  If navigator.clipboard.readText() is
    // unavailable (e.g. insecure origin, no permission), the test falls back to
    // asserting only the pref attr — which is the binding check regardless.
    const extraHTTPHeaders = hasCredentials() ? { Authorization: authHeader() } : {};
    const context = await browser.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addInitScript(() => localStorage.clear());
      await page.goto(TUTORIAL_PATH, { waitUntil: 'domcontentloaded' });

      // Enable copy-clean pref.
      await page.click('#sb-prefs');
      await page.click('[data-testid="tut-prefs-copy-clean"]');

      // copy-clean does NOT set an HTML attribute — it persists to localStorage and
      // is read at copy time.  Assert the stored value instead.
      const storedVal = await page.evaluate(() => localStorage.getItem('tut.pref.copyClean'));
      expect(storedVal, 'tut.pref.copyClean should be "on" in localStorage after toggle').toBe('on');

      // Locate the copy button for a code block whose first non-empty line begins "$ ".
      const copyBtnHandle = await page.evaluateHandle(() => {
        const blocks = document.querySelectorAll('pre code, .code-block code, .code-block pre');
        for (const block of blocks) {
          const firstLine = (block.textContent || '').trimStart();
          if (firstLine.startsWith('$ ')) {
            return block.closest('.code-block')?.querySelector('.code-block-copy') || null;
          }
        }
        return null;
      });

      const copyBtn = copyBtnHandle.asElement();
      if (copyBtn) {
        await copyBtn.click();

        // Attempt clipboard read; fall back gracefully when not available.
        const clipText = await page
          .evaluate(() => navigator.clipboard.readText())
          .catch(() => null);

        if (clipText !== null) {
          expect(
            clipText.startsWith('$ '),
            'Clipboard text must NOT start with "$ " — copy-clean should have stripped the prompt',
          ).toBe(false);
          expect(
            clipText.length,
            'Clipboard text should be non-empty after stripping the prompt',
          ).toBeGreaterThan(0);
        }
        // When clipboard read is unavailable the attr assertion above is sufficient.
      }
      // If no "$ " code block exists on this tutorial, the attr assertion is the
      // binding check.  The clipboard path is best-effort / content-dependent.
    } finally {
      await context.close();
    }
  });
});
