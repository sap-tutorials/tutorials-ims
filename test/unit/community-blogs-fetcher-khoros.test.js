// test/unit/community-blogs-fetcher-khoros.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { fetchOneSource } from '../../srv/lib/community-blogs-fetcher.js';
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
