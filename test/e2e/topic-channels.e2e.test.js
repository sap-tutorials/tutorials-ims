// e2e: related-channels band on /topics/<slug>/ pages (P3 surface C).
// Path: browser → approuter /topics/ → leaf topic → topic detail page with
// optional .topic-channels band.
// No auth — topic pages are publicly accessible.
//
// Band assertion is TOLERANT: the crosswalk may be all-AI_SEEDED / empty until
// curators promote entries to REVIEWED. The test asserts <main>/<h1> regardless;
// it only enters the channels-band branch when .topic-channels is actually
// present — so this passes on a freshly-seeded env with no reviewed mappings
// AND on an env where the band is live.
//
// Self-skips when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so
// `npm test` (unit tier) and credential-less local runs stay green.
//
// Run against a deployed approuter:
//   SMOKE_BASE_URL=https://… npx vitest run --project e2e test/e2e/topic-channels.e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: /topics related-channels band (public)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('topic pages render, and any related-channels band is well-formed', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // Navigate to topics index and open the first facet <details> so its
      // children are in the DOM before clicking (mirrors topics.spec.ts leaf
      // navigation flow verbatim: #topics-tree-root → details.open → a[href^="/topics/"]).
      await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      const firstDetails = page.locator('#topics-tree-root details').first();
      await firstDetails.evaluate((el) => { el.open = true; });

      // Wait for a visible topic link; skip gracefully if none appears
      // (tree empty or fully collapsed on this env — same early-return as topics.spec.ts).
      const firstTopic = page.locator('#topics-tree-root a[href^="/topics/"]').first();
      const visible = await firstTopic.isVisible().catch(() => false);
      if (!visible) return; // graceful skip — no actionable topic link found

      await firstTopic.click();
      await page.waitForURL(/\/topics\/[a-z0-9-]+\//);
      expect(page.url()).toMatch(/\/topics\/[a-z0-9-]+\//);

      // Served pages render <main> + <h1>, NOT <article> (verified repo fact).
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(
        await page.locator('main').count(),
        'topic detail page must render a <main> element'
      ).toBeGreaterThan(0);
      expect(
        await page.locator('h1').count(),
        'topic detail page must render an <h1> heading'
      ).toBeGreaterThan(0);

      // Tolerant band check: .topic-channels only appears when the ChannelTopicMap
      // crosswalk has at least one REVIEWED entry for this topic. On a
      // freshly-seeded env all entries are AI_SEEDED — band is absent, which is
      // valid. Only assert structural contract when the band is actually rendered.
      const bandCount = await page.locator('.topic-channels').count();
      if (bandCount === 0) return; // no reviewed channel mappings yet — tolerant pass

      const band = page.locator('.topic-channels').first();
      expect(
        await band.locator('h2').count(),
        'related-channels band must have an <h2> heading'
      ).toBeGreaterThan(0);
      expect(
        await band.locator('a').count(),
        'related-channels band must have at least one <a> link'
      ).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
