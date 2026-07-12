// test/unit/homepage-news-filter.test.js
// Tests for homepage news() handler rewrite (#1034):
//   - Two-layer kill switch (env + HomepageConfig.newsRelevanceEnabled)
//   - Reads from NewsItems, filters by language, publishedAt, aiVerdict, adminVerdict
//   - 60s in-process cache; resetNewsCache() invalidates it
//
// Bootstrap pattern matches homepage-service-endpoints.test.js and fetch-news-job.test.js:
// cds.test() at module level, beforeEach handles DB cleanup + cache reset.
//
// Legacy-path tests (kill switch OFF) use vi.stubGlobal('fetch', ...) + _resetForTests()
// on the RSS fetcher to control what fetchRssItems returns. Direct vi.mock() of
// homepage-rss-fetcher.js does NOT intercept inside CDS-loaded service modules
// (CDS loads homepage-service.js via Node's native ESM loader, bypassing Vitest's
// module interceptor). This matches the pattern established in homepage-rss-fetcher.test.js.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests as resetRssFetcherCache } from '../../srv/lib/homepage-rss-fetcher.js';

cds.test('serve', '--project', '.', '--in-memory');

const FAKE_RSS_ITEM_XML = `<?xml version="1.0"?><rss><channel>
  <item><title>passthrough</title><link>https://x</link></item>
</channel></rss>`;

const FAKE_ENV_RSS_XML = `<?xml version="1.0"?><rss><channel>
  <item><title>env-forced-passthrough</title><link>https://x</link></item>
</channel></rss>`;

describe('homepage news() with #1034 filter', () => {
  let srv;
  let db;

  beforeAll(async () => {
    srv = await cds.connect.to('HomepageService');
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // #1145: homepage-rss-fetcher now injects the curl transport into safeFetch
    // by default (to beat Cloudflare's JA3 block on community.sap.com). The curl
    // transport bypasses vi.stubGlobal('fetch', ...), so the legacy-path tests
    // below would hit the real network. RSS_TRANSPORT=fetch reverts the fetcher
    // to native fetch so the stubbed global fetch intercepts. Mirrors the guard
    // in homepage-rss-fetcher.test.js.
    process.env.RSS_TRANSPORT = 'fetch';
    resetRssFetcherCache();
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: false }));
    const mod = await import('../../srv/homepage-service.js');
    mod._resetForTests();
    delete process.env.HOMEPAGE_NEWS_RELEVANCE_ENABLED;
  });

  afterEach(() => {
    delete process.env.HOMEPAGE_NEWS_RELEVANCE_ENABLED;
    delete process.env.RSS_TRANSPORT;
  });

  async function seedRow(overrides = {}) {
    await db.run(INSERT.into('com.sap.developers.ims.external.NewsItems').entries({
      sourceId: 's-' + Math.random().toString(36).slice(2),
      link: 'https://news.sap.com/x',
      title: 'x',
      description: 'y',
      publishedAt: new Date().toISOString(),
      language: 'en',
      contentHash: 'h',
      aiVerdict: 'relevant',
      aiReason: 'r', aiVerdictSource: 'embedding', aiConfidence: 0.9,
      aiVerdictAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      ...overrides,
    }));
  }

  it('kill switch off (HomepageConfig=false) → falls back to legacy RSS pass-through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FAKE_RSS_ITEM_XML, { status: 200 })));
    const r = await srv.send({ event: 'news' });
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('passthrough');
  });

  it('kill switch on → serves relevant items from NewsItems, capped at 2', async () => {
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ title: 'A' });
    await seedRow({ title: 'B' });
    await seedRow({ title: 'C' });
    const r = await srv.send({ event: 'news' });
    expect(r).toHaveLength(2);
    // Confirm RSS was NOT called (no stubbed fetch, if it was called it would throw)
  });

  it('adminVerdict=approve overrides aiVerdict=not-relevant', async () => {
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ aiVerdict: 'not-relevant', adminVerdict: 'approve', title: 'admin-approved' });
    const r = await srv.send({ event: 'news' });
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('admin-approved');
  });

  it('adminVerdict=reject hides an ai-relevant item', async () => {
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ aiVerdict: 'relevant', adminVerdict: 'reject' });
    const r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });

  it('items older than 14 days are excluded', async () => {
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await seedRow({ publishedAt: old });
    const r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });

  it('non-English rows never appear', async () => {
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ language: null, aiVerdict: 'pending' });
    const r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });

  it('env HOMEPAGE_NEWS_RELEVANCE_ENABLED=false dominates HomepageConfig=true', async () => {
    process.env.HOMEPAGE_NEWS_RELEVANCE_ENABLED = 'false';
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FAKE_ENV_RSS_XML, { status: 200 })));
    const r = await srv.send({ event: 'news' });
    expect(r[0].title).toBe('env-forced-passthrough');
  });

  it('resetNewsCache invalidates the 60s cache', async () => {
    await db.run(UPDATE('com.sap.developers.ims.HomepageConfig').set({ newsRelevanceEnabled: true }));
    await seedRow({ title: 'first' });
    let r = await srv.send({ event: 'news' });
    expect(r[0].title).toBe('first');
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
    // Without reset, cache returns stale.
    r = await srv.send({ event: 'news' });
    expect(r[0].title).toBe('first');
    // Reset then expect empty.
    const mod = await import('../../srv/homepage-service.js');
    mod.resetNewsCache();
    r = await srv.send({ event: 'news' });
    expect(r).toEqual([]);
  });
});
