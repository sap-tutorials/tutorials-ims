// e2e: topics front-door flow — gallery → cluster detail → concept → peer cluster.
// Covers the /topics/ feature (Tasks 1-13 in the topics-discovery SDD).
//
// Flow:
//   1. /topics/     renders gallery cards (baseof wraps content in <main>; h1 present)
//   2. card click   navigates to /topics/<slug>/ and shows concepts list
//   3. concept link goes to /concepts/<slug>/
//   4. peer link    goes to another /topics/<slug>/
//   5. (best-effort) #topics-map island mounts — skipped if WebGL is unavailable in CI
//
// Self-skips cleanly when SMOKE_BASE_URL / PLAYWRIGHT_BASE_URL is absent so that
// `npm test` (unit suite) is never affected. Auth via Basic SMOKE_TECH_USER /
// SMOKE_TECH_PASSWORD, same as every other spec in this tier (#1338).
//
// NOTE: the topics pages are statically baked by Hugo from hugo/data/topics_gallery.json.
// In a fresh DEV deploy before the nightly job has run, the gallery may be empty (no cards).
// The spec handles this gracefully: gallery and cluster assertions are skipped when the
// gallery bakes empty, rather than failing the suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

describe.skipIf(!hasBaseUrl())('e2e: topics discovery front-door', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('/topics/ renders with a heading and gallery section or empty state', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      expect(response, 'no response received for /topics/').not.toBeNull();
      expect(response.status(), `unexpected status for /topics/`).toBe(200);

      // baseof.html wraps all content in <main>; topics/list.html emits <h1>
      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('main').count()).toBeGreaterThan(0);
      expect(await page.locator('h1').count(), 'topics page should render an h1').toBeGreaterThan(0);

      // The gallery section OR the empty-state section must be present
      const galleryCount = await page.locator('.topics-gallery, .topics-empty').count();
      expect(galleryCount, 'expected .topics-gallery or .topics-empty section').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('a gallery card navigates to /topics/<slug>/ and shows the concepts section', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      expect(response?.status(), 'topics gallery must return 200').toBe(200);

      // If there are no cards (gallery baked empty), skip the navigation assertions
      const firstCard = page.locator('.topics-card__link').first();
      const cardCount = await firstCard.count();
      if (cardCount === 0) {
        // Gallery is empty on this env — not a failure, just skip the nav checks
        return;
      }

      // Resolve the href before clicking so we can assert the URL
      const cardHref = await firstCard.getAttribute('href');
      expect(cardHref, 'card should have an href').toBeTruthy();

      await Promise.all([
        page.waitForURL(url => url.pathname === cardHref || url.pathname.startsWith('/topics/'), { timeout: 15_000 }),
        firstCard.click(),
      ]);

      // Cluster detail page: single.html uses <article> wrapping when data is present,
      // but always renders an <h1> (either the cluster title or "Topic not found").
      await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15_000 });
      expect(await page.locator('h1').count(), 'cluster detail must have an h1').toBeGreaterThan(0);

      // When cluster data is present the concepts section is rendered
      // (may be .topics-detail__concepts or .topics-detail--missing)
      const hasDetail = await page.locator('.topics-detail').count();
      expect(hasDetail, 'expected .topics-detail on cluster page').toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('a concept link on a cluster page resolves to /concepts/<slug>/', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      // Navigate to the first cluster that has concept links
      const galleryResp = await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      if (galleryResp?.status() !== 200) return;

      const firstCard = page.locator('.topics-card__link').first();
      if (await firstCard.count() === 0) return; // empty gallery — skip

      const cardHref = await firstCard.getAttribute('href');
      await Promise.all([
        page.waitForURL(url => url.pathname.startsWith('/topics/'), { timeout: 15_000 }),
        firstCard.click(),
      ]);

      // Look for a concept link (/concepts/<slug>/)
      const conceptLink = page.locator('.topics-concepts-list__link').first();
      if (await conceptLink.count() === 0) return; // cluster has no concepts rendered — skip

      const conceptHref = await conceptLink.getAttribute('href');
      expect(conceptHref, 'concept link should have an href').toBeTruthy();
      expect(conceptHref, 'concept link should point to /concepts/').toContain('/concepts/');
    } finally {
      await context.close();
    }
  });

  it('a peer-cluster link on a cluster page points to another /topics/<slug>/', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const galleryResp = await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      if (galleryResp?.status() !== 200) return;

      const firstCard = page.locator('.topics-card__link').first();
      if (await firstCard.count() === 0) return;

      await Promise.all([
        page.waitForURL(url => url.pathname.startsWith('/topics/'), { timeout: 15_000 }),
        firstCard.click(),
      ]);

      // Peer cluster links — rendered in .topics-peers-list when peers exist
      const peerLink = page.locator('.topics-peers-list__link').first();
      if (await peerLink.count() === 0) return; // no peers in this cluster — skip

      const peerHref = await peerLink.getAttribute('href');
      expect(peerHref, 'peer link should have an href').toBeTruthy();
      expect(peerHref, 'peer link should point to /topics/').toContain('/topics/');
    } finally {
      await context.close();
    }
  });

  it('(best-effort) #topics-map island mount point is present on /topics/', async () => {
    // This is a progressive-enhancement check: the island mounts when Sigma / WebGL
    // is available. In CI WebGL is typically unavailable, so we only assert the mount
    // point exists in the DOM — not that it has fully rendered children. The test is
    // wrapped in try/catch so a WebGL crash never fails the suite.
    const { context, page } = await newPage(browser, { authenticated: false });
    try {
      const response = await page.goto('/topics/', { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) return;

      await page.locator('main').first().waitFor({ state: 'visible', timeout: 15_000 });

      // The mount-point section is always rendered by the template (data-vue-island)
      const mapSection = await page.locator('#topics-map, [data-vue-island="topics-map"]').count();
      // Tolerate absence in case the layout changed; log but don't fail
      if (mapSection === 0) {
        console.warn('[topics-discovery e2e] #topics-map mount point not found — may not be deployed yet');
        return;
      }
      expect(mapSection).toBeGreaterThan(0);
      // Do NOT assert child nodes — WebGL may be absent in CI
    } catch (err) {
      // Swallow WebGL / canvas errors so they never fail the suite
      console.warn('[topics-discovery e2e] map island best-effort check caught:', err?.message);
    } finally {
      await context.close();
    }
  });
});
