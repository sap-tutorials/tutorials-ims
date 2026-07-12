import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchRssItems, _resetForTests } from '../../srv/lib/homepage-rss-fetcher.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

beforeEach(() => {
  _resetForTests();
  vi.restoreAllMocks();
  // #895: safeFetch does a DNS lookup on every hop. In unit tests we stub
  // it to return a public IP so the private-IP block passes.
  _setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
  // Production defaults to the curl transport (Cloudflare JA3 block — see
  // srv/lib/curl-transport.js). These tests stub global.fetch, so pin the
  // native-fetch path; the curl transport has its own test file.
  process.env.RSS_TRANSPORT = 'fetch';
});

afterEach(() => {
  _setLookupForTests(null);
  delete process.env.RSS_TRANSPORT;
});

const FAKE_RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Post A</title><link>https://x/a</link><pubDate>Fri, 26 Jun 2026 10:00:00 GMT</pubDate><description>Desc A</description></item>
  <item><title>Post B</title><link>https://x/b</link><pubDate>Thu, 25 Jun 2026 09:00:00 GMT</pubDate></item>
  <item><title>Post C</title><link>https://x/c</link><pubDate>Wed, 24 Jun 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

describe('fetchRssItems', () => {
  it('parses items, sorts newest first, caps at limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FAKE_RSS, { status: 200 })));
    const items = await fetchRssItems('https://x/rss', { limit: 2 });
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Post A');
    expect(items[0].link).toBe('https://x/a');
    expect(items[0].description).toBe('Desc A');
    expect(items[1].title).toBe('Post B');
  });

  it('returns empty on network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const items = await fetchRssItems('https://x/rss', { limit: 5 });
    expect(items).toEqual([]);
  });

  it('returns empty on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const items = await fetchRssItems('https://x/rss', { limit: 5 });
    expect(items).toEqual([]);
  });

  it('caches second call within TTL (fetch called once)', async () => {
    const stub = vi.fn(async () => new Response(FAKE_RSS, { status: 200 }));
    vi.stubGlobal('fetch', stub);
    await fetchRssItems('https://x/rss', { limit: 5 });
    await fetchRssItems('https://x/rss', { limit: 5 });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failed responses (retries on next call)', async () => {
    const stub = vi.fn(async () => { throw new Error('network'); });
    vi.stubGlobal('fetch', stub);
    await fetchRssItems('https://x/rss', { limit: 5 });
    await fetchRssItems('https://x/rss', { limit: 5 });
    expect(stub).toHaveBeenCalledTimes(2);  // second call retries
  });

  it('handles CDATA-wrapped fields', async () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[Hello & Goodbye]]></title><link>https://x/cdata</link><pubDate>Fri, 26 Jun 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rss, { status: 200 })));
    const items = await fetchRssItems('https://x/rss', { limit: 1 });
    expect(items[0].title).toBe('Hello & Goodbye');
  });

  it('drops items missing title or link', async () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>Good</title><link>https://x/good</link><pubDate>Fri, 26 Jun 2026 10:00:00 GMT</pubDate></item>
      <item><title>NoLink</title><pubDate>Thu, 25 Jun 2026 09:00:00 GMT</pubDate></item>
      <item><link>https://x/notitle</link><pubDate>Wed, 24 Jun 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rss, { status: 200 })));
    const items = await fetchRssItems('https://x/rss', { limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Good');
  });
});
