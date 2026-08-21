// e2e: tutorial Print / Save-as-PDF (#1943). Anonymous, like tutorial-serve.
// Verifies the two ways a reader triggers printing:
//   1. Clicking the header Print button calls window.print().
//   2. Loading /tutorials/<slug>/?print=1 auto-calls window.print() on load.
// We can't assert the OS print dialog, so we stub window.print via
// addInitScript (runs before any page script) and count calls from a flag on
// window. print.css handles the actual print-media layout; that's not asserted
// here.
//
// The slug is discovered from GET /content/hashes (like the Done-button smoke)
// so the spec doesn't rot when a hardcoded tutorial is unpublished.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright-core';
import { BASE_URL, SRV_URL, hasBaseUrl } from './e2e.config.js';

const STUB_PRINT = `
  window.__printCalls = 0;
  window.print = function () { window.__printCalls++; };
`;

describe.skipIf(!hasBaseUrl())('e2e: tutorial print / save-as-pdf (#1943)', () => {
  let browser;
  let slug;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // Pick a real step-based tutorial (skip concept-* pages, which render
    // without the tutorial header layout).
    const res = await fetch(`${SRV_URL}/content/hashes`);
    if (res.ok) {
      const body = await res.json();
      const slugs = Object.keys(body);
      slug = slugs.find((s) => !s.startsWith('concept-')) ?? slugs[0];
    }
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('clicking the Print button calls window.print()', async () => {
    expect(slug, 'no published tutorial slug available').toBeTruthy();
    const context = await browser.newContext({ baseURL: BASE_URL });
    await context.addInitScript(STUB_PRINT);
    const page = await context.newPage();
    try {
      const response = await page.goto(`/tutorials/${slug}`, { waitUntil: 'domcontentloaded' });
      expect(response.status(), `unexpected status for /tutorials/${slug}`).toBe(200);
      const btn = page.locator('[data-action="print-tutorial"]');
      await btn.waitFor({ state: 'visible', timeout: 20_000 });
      await btn.click();
      const calls = await page.evaluate(() => window.__printCalls);
      expect(calls, 'window.print() was not called on button click').toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  it('?print=1 auto-calls window.print() on load', async () => {
    expect(slug, 'no published tutorial slug available').toBeTruthy();
    const context = await browser.newContext({ baseURL: BASE_URL });
    await context.addInitScript(STUB_PRINT);
    const page = await context.newPage();
    try {
      const response = await page.goto(`/tutorials/${slug}/?print=1`, { waitUntil: 'load' });
      expect(response.status()).toBe(200);
      // initPrintDeepLink defers ~300ms after load before firing.
      await page.waitForFunction(() => window.__printCalls > 0, { timeout: 5_000 });
      const calls = await page.evaluate(() => window.__printCalls);
      expect(calls, 'window.print() was not auto-called for ?print=1').toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});
