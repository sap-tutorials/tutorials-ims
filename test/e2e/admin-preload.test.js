// e2e: a preload-built admin tile actually loads its Component-preload.js (#2749).
// Path: browser → approuter /admin-ui/#puzzles (XSUAA) → sap.tnt.ToolPage shell →
//       puzzles componentUsage. With preload enabled, UI5 (async bootstrap) MUST
//       fetch components/puzzles/Component-preload.js — the single bundle that
//       replaces ~10 per-module round-trips. This spec is the live proof of the
//       thing static checks can't confirm: that the shipped preload is used, under
//       the real approuter CSP, with no module load error.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage, requireCredentials } from './_browser.js';

describe.skipIf(!hasBaseUrl() || !hasCredentials())('e2e: admin preload (authenticated)', () => {
  let browser;
  beforeAll(async () => {
    requireCredentials();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('#puzzles fetches Component-preload.js (200) and renders without a module error', async () => {
    const { context, page } = await newPage(browser);
    try {
      // Record whether the preload bundle is fetched and with what status.
      const preloadResponses = [];
      page.on('response', (res) => {
        if (/\/admin-ui\/components\/puzzles\/Component-preload\.js(\?|$)/.test(res.url())) {
          preloadResponses.push(res.status());
        }
      });
      // Fail the assertion if UI5 logs a module load error (preload broken → it
      // would fall back to per-module loads, or 404 the worker/libs).
      const moduleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && /ModuleError|failed to load|Component-preload/i.test(msg.text())) {
          moduleErrors.push(msg.text());
        }
      });

      await page.goto('/admin-ui/#puzzles', { waitUntil: 'domcontentloaded' });
      // The crossword builder view surfaces as a UI5 control tree; wait for the
      // shell content area to render something from the component.
      await page
        .locator('.sapMPage, .sapUiView, [role="main"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });

      // The preload must have been fetched at least once, and every fetch 200.
      expect(preloadResponses.length).toBeGreaterThan(0);
      expect(preloadResponses.every((s) => s === 200)).toBe(true);
      expect(moduleErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
