// test/unit/community-blogs-fetcher-khoros.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { fetchOneSource, fetchAllSources } from '../../srv/lib/community-blogs-fetcher.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

// Load CDS model (in-memory SQLite) so cds.entities() resolves inside upsertOne.
cds.test('serve', '--project', '.', '--in-memory');

const KHOROS_FIXTURE = {
  status: 'success', http_code: 200,
  data: { items: [{
    view_href: 'https://community.sap.com/t5/x/ba-p/1',
    author: { login: 'u' }, subject: 'Hello World Blog Post',
    teaser: '<p>body text here</p>', post_time: '2026-07-12T13:10:31.131+02:00',
  }] },
};

describe('fetchOneSource — khoros mode', () => {
  beforeEach(() => {
    process.env.RSS_TRANSPORT = 'khoros';
    _setLookupForTests(async () => [{ address: '104.18.0.1', family: 4 }]); // public IP
  });
  afterEach(() => {
    delete process.env.RSS_TRANSPORT;
    _setLookupForTests(null);
    vi.unstubAllGlobals();
  });

  it('fetches via the Khoros API URL and upserts items', async () => {
    const fetchSpy = vi.fn(async (url) => {
      expect(url).toContain('community.sap.com/api/2.0/search');
      expect(decodeURIComponent(url)).toContain("board.id='technology-blog-sap'");
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify(KHOROS_FIXTURE) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const db = { run: vi.fn(async () => undefined) }; // no existing row → INSERT path
    const source = { ID: 's1', label: 'SAP', topicSlug: 'technology-sap',
      feedUrl: 'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap',
      apiQuery: "board.id='technology-blog-sap'" };

    const stats = await fetchOneSource(source, { db });
    expect(fetchSpy).toHaveBeenCalled();
    expect(stats.fetched).toBe(1);
    expect(stats.inserted).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// fetchAllSources — end-to-end SELECT projection guard (#1144 critical fix)
//
// This test drives fetchAllSources() against a real in-memory CDS DB so that
// the SELECT.columns(...) projection inside fetchAllSources is actually exercised
// and the apiQuery field is available at runtime. A hand-built source object
// (as used by fetchOneSource tests) would bypass the SELECT entirely and miss
// the regression.
//
// Approach: cds.test() is already loaded above. We use the real db to
// INSERT a new source row with a non-null apiQuery, then call fetchAllSources()
// with RSS_TRANSPORT=khoros and a stubbed global.fetch. The stub asserts the
// Khoros URL is built (which only happens when source.apiQuery is non-undefined
// after the SELECT). If apiQuery were dropped from the SELECT again, fetch
// would be called with the curl fallback path (different URL) and the test
// would fail.
// -----------------------------------------------------------------------------

describe('fetchAllSources — SELECT projection includes apiQuery (#1144)', () => {
  let db;
  const TEST_SOURCE_ID = '00000000-0000-0000-0000-000000c8ff01';

  beforeEach(async () => {
    db = await cds.connect.to('db');
    const { CommunityBlogSources } = cds.entities('com.sap.developers.ims');
    // Insert a dedicated test source with a known apiQuery and isActive=true.
    // Use upsert semantics (DELETE+INSERT) so re-runs are idempotent.
    await db.run(DELETE.from(CommunityBlogSources).where({ ID: TEST_SOURCE_ID }));
    await db.run(INSERT.into(CommunityBlogSources).entries({
      ID: TEST_SOURCE_ID,
      label: 'Test Khoros Source',
      feedUrl: 'https://community.sap.com/khhcw49343/rss/board?board.id=test-board',
      topicSlug: 'test-khoros-apiquery-guard',
      isActive: true,
      sortOrder: 999,
      managed: false,
      apiQuery: "board.id='test-board'",
    }));

    process.env.RSS_TRANSPORT = 'khoros';
    _setLookupForTests(async () => [{ address: '104.18.0.1', family: 4 }]);
  });

  afterEach(async () => {
    delete process.env.RSS_TRANSPORT;
    _setLookupForTests(null);
    vi.unstubAllGlobals();
    // Clean up test row so it does not affect other tests.
    const { CommunityBlogSources } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(CommunityBlogSources).where({ ID: TEST_SOURCE_ID }));
  });

  it('routes the test source through Khoros (fetch spy called with /api/2.0/search and the board predicate)', async () => {
    // Collect all URLs that fetch is called with.
    const calledUrls = [];
    const fetchSpy = vi.fn(async (url) => {
      calledUrls.push(typeof url === 'string' ? url : String(url));
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          status: 'success', http_code: 200,
          data: { items: [{
            view_href: 'https://community.sap.com/t5/test/ba-p/1',
            author: { login: 'tester' },
            subject: 'Test post from apiQuery guard',
            teaser: 'teaser text',
            post_time: '2026-07-12T00:00:00.000+00:00',
          }] },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const total = await fetchAllSources();

    // At least one call must target the Khoros search API
    const khorosCalls = calledUrls.filter((u) => u.includes('/api/2.0/search'));
    expect(khorosCalls.length).toBeGreaterThanOrEqual(1);

    // The Khoros URL must encode the board predicate from apiQuery
    const hasBoard = khorosCalls.some((u) =>
      decodeURIComponent(u).includes("board.id='test-board'")
    );
    expect(hasBoard, 'Khoros URL should contain board.id predicate from apiQuery').toBe(true);

    // Overall: sources processed >= 1 (our inserted row at minimum)
    expect(total.sources).toBeGreaterThanOrEqual(1);
  });
});
