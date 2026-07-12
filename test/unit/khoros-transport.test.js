import { describe, it, expect } from 'vitest';
import { buildKhorosUrl, validateApiQuery, itemsToRssXml, khorosFetch } from '../../srv/lib/khoros-transport.js';
import { parseRss } from '../../srv/lib/rss-parse.js';
import { vi, afterEach } from 'vitest';

describe('buildKhorosUrl', () => {
  it('wraps the predicate in parens and appends fixed clauses, URL-encoded', () => {
    const url = buildKhorosUrl("board.id='technology-blog-sap'");
    expect(url.startsWith('https://community.sap.com/api/2.0/search?q=')).toBe(true);
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    expect(q).toBe(
      "SELECT subject,post_time,view_href,teaser,author.login FROM messages " +
      "WHERE (board.id='technology-blog-sap') AND depth=0 ORDER BY post_time DESC LIMIT 20"
    );
  });
});

describe('validateApiQuery', () => {
  it('accepts clean board/category predicates', () => {
    expect(validateApiQuery("board.id='technology-blog-sap'")).toBe(true);
    expect(validateApiQuery("category.id='technology' AND conversation.style='blog'")).toBe(true);
  });
  it('rejects injection attempts', () => {
    expect(validateApiQuery("x=1; DROP")).toBe(false);        // semicolon
    expect(validateApiQuery("x=1 LIMIT 999")).toBe(false);    // LIMIT
    expect(validateApiQuery("x=1) SELECT")).toBe(false);      // paren + SELECT
    expect(validateApiQuery("x=1 ORDER BY y")).toBe(false);   // ORDER
    expect(validateApiQuery('x=1\\')).toBe(false);            // backslash
    expect(validateApiQuery('')).toBe(false);                 // empty
    expect(validateApiQuery(null)).toBe(false);
  });
});

// Real Khoros payload captured 2026-07-12 from
// /api/2.0/search?q=...board.id='technology-blog-sap'...LIMIT 2
const KHOROS_FIXTURE = {
  status: 'success', message: '', http_code: 200,
  data: {
    type: 'messages', list_item_type: 'message', size: 2,
    items: [
      {
        type: 'message',
        view_href: 'https://community.sap.com/t5/technology-blog-posts-by-sap/api-centric-integration-on-sap-integration-suite-part-2-api-governance-with/ba-p/14438473',
        author: { type: 'user', login: 'Ashutosh_KSingh' },
        subject: 'API-Centric Integration on SAP Integration Suite – Part 2: API Governance with Developer Hub',
        teaser: "<P>In this artcile, you'll learn how to govern and publish deployed APIs using <STRONG>Developer Hub</STRONG>.</P>",
        post_time: '2026-07-12T13:10:31.131+02:00',
        message_type: 'blog_topic_message',
      },
      {
        type: 'message',
        view_href: 'https://community.sap.com/t5/technology-blog-posts-by-sap/api-centric-integration-on-sap-integration-suite-part-1-build-and-deploy/ba-p/14438357',
        author: { type: 'user', login: 'Ashutosh_KSingh' },
        subject: 'API-Centric Integration on SAP Integration Suite – Part 1: Build and Deploy Your API',
        teaser: '<P class="">Looking to get started with API-centric integration?</P>',
        post_time: '2026-07-12T05:04:44.084+02:00',
        message_type: 'blog_topic_message',
      },
    ],
    next_cursor: 'abc',
  },
  metadata: {},
};

describe('itemsToRssXml → parseRss round-trip', () => {
  it('produces XML that parseRss reads into the expected item shape', () => {
    const xml = itemsToRssXml(KHOROS_FIXTURE.data.items);
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain('API Governance with Developer Hub');
    expect(items[0].link).toBe(KHOROS_FIXTURE.data.items[0].view_href);
    expect(items[0].author).toBe('Ashutosh_KSingh');
    expect(items[0].publishedAt).toBe(new Date('2026-07-12T13:10:31.131+02:00').toISOString());
    expect(items[0].language).toBe('en');           // channel <language>en so isEnglish accepts
    expect(items[0].description).toContain('Developer Hub');
  });

  it('escapes XML metacharacters in subject/teaser', () => {
    const xml = itemsToRssXml([{
      view_href: 'https://community.sap.com/x/ba-p/1',
      subject: 'A & B <tag> "q"', teaser: 'x & y', post_time: '2026-01-01T00:00:00.000+00:00',
      author: { login: 'u' },
    }]);
    expect(xml).not.toMatch(/<title>A & B <tag>/);   // raw & / < must be escaped
    const items = parseRss(xml);
    expect(items[0].title).toBe('A & B <tag> "q"');   // round-trips back to literal
  });
});

describe('khorosFetch', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('fetches JSON and returns a Response-shaped object whose text() is RSS XML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => KHOROS_FIXTURE,
      text: async () => JSON.stringify(KHOROS_FIXTURE),
    })));
    const res = await khorosFetch('https://community.sap.com/api/2.0/search?q=x');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    const items = parseRss(await res.text());
    expect(items).toHaveLength(2);
  });

  it('propagates a non-2xx status (CF egress 403 signal)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({}), text: async () => 'blocked',
    })));
    const res = await khorosFetch('https://community.sap.com/api/2.0/search?q=x');
    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
  });

  it('fails open on malformed JSON → empty item list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => { throw new Error('bad json'); },
      text: async () => 'not json',
    })));
    const res = await khorosFetch('https://community.sap.com/api/2.0/search?q=x');
    expect(res.status).toBe(200);
    expect(parseRss(await res.text())).toEqual([]);
  });
});
