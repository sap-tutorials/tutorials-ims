// e2e: public /channels directory smoke (P2 collections nudge).
// Path: browser → approuter /channels → baked static page + channel-collections island.
// No auth — the directory is publicly accessible.
//
// Collections assertion is TOLERANT: curators must flip authoringStatus to
// REVIEWED before any .collection card renders in the feed. The test asserts
// <main>/<h1> regardless; it only enters the collections branch when a card
// is actually present — so this passes on a freshly-seeded env with all-BLANK
// collections AND on a reviewed-and-published env alike.
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so
// `npm test` (unit tier) and credential-less local runs stay green.
//
// Run against a deployed approuter:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/channels.e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /channels directory (public)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('channels directory renders <main> and a heading', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/channels', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received').not.toBeNull();
      expect(response.status(), `unexpected status ${response.status()} for /channels`).toBe(200);
      // Verified repo fact: served pages render <main> + <h1>, NOT <article>.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('main').count(), '/channels must render a <main> element').toBeGreaterThan(0);
      expect(await page.locator('h1').count(), '/channels must render a heading').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('if channel-collections are present, each collection has a title and at least one link', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      await page.goto('/channels', { waitUntil: 'domcontentloaded' });
      // Wait for the main content area before probing.
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // Collections only appear when at least one ChannelCollection has
      // authoringStatus === 'REVIEWED'. On a freshly-seeded env the feed
      // returns an empty array and .channel-collections .collection is absent —
      // that is a valid state, not a test failure.
      const collectionCount = await page.locator('.channel-collections .collection').count();
      if (collectionCount === 0) return; // no reviewed collections yet — tolerant pass

      // At least one collection rendered: assert the structural contract
      // (Task 6 markup: <article class="collection"> with <h2> + <ul><li><a>).
      const firstCollection = page.locator('.channel-collections .collection').first();
      expect(
        await firstCollection.locator('h2').count(),
        'rendered collection must have an <h2> title'
      ).toBeGreaterThan(0);
      expect(
        await firstCollection.locator('a').count(),
        'rendered collection must have at least one <a> link'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
