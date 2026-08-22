// test/unit/mcp-news-detail.test.js
//
// Unit tests for the get_news_detail MCP tool helpers (Tier 2). Pure functions
// with an injectable fetch — no network, no DB.

import { expect, describe, it, beforeEach } from 'vitest';
import {
  isAllowedNewsHost,
  htmlToText,
  fetchNewsDetail,
  _resetCacheForTest,
} from '../../srv/lib/mcp-news-detail.js';

beforeEach(() => _resetCacheForTest());

describe('isAllowedNewsHost', () => {
  it('accepts the SAP news hosts and their subdomains', () => {
    expect(isAllowedNewsHost('https://news.sap.com/2026/08/some-post/')).toBe(true);
    expect(isAllowedNewsHost('https://community.sap.com/t5/x/y')).toBe(true);
    expect(isAllowedNewsHost('https://blogs.sap.com/2026/08/post/')).toBe(true);
    expect(isAllowedNewsHost('https://www.news.sap.com/x')).toBe(true);
  });

  it('rejects non-SAP hosts, look-alikes, and non-http schemes', () => {
    expect(isAllowedNewsHost('https://evil.com/news.sap.com')).toBe(false);
    expect(isAllowedNewsHost('https://news.sap.com.evil.com/x')).toBe(false);
    expect(isAllowedNewsHost('file:///etc/passwd')).toBe(false);
    expect(isAllowedNewsHost('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedNewsHost('not a url')).toBe(false);
  });
});

describe('htmlToText', () => {
  it('strips scripts/styles/tags, decodes entities, collapses whitespace', () => {
    const html = `<html><head><style>.x{color:red}</style></head>
      <body><script>alert(1)</script><p>Hello&nbsp;&amp;   world &#39;quote&#39;</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Hello & world');
    expect(text).toContain("'quote'");
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
  });

  it('prefers the <article> body when present', () => {
    const html = '<body><nav>MENU JUNK</nav><article>Real content here</article><footer>FOOT</footer></body>';
    const text = htmlToText(html);
    expect(text).toContain('Real content here');
    expect(text).not.toContain('MENU JUNK');
    expect(text).not.toContain('FOOT');
  });

  it('caps output length at 20k chars', () => {
    const big = '<article>' + 'a'.repeat(50_000) + '</article>';
    expect(htmlToText(big).length).toBe(20_000);
  });

  it('returns empty string for falsy input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
  });
});

describe('fetchNewsDetail', () => {
  const okFetch = (html) => async () => ({ ok: true, status: 200, text: async () => html });

  it('rejects a disallowed host before any fetch', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, text: async () => '' }; };
    await expect(fetchNewsDetail('https://evil.com/x', { fetchImpl }))
      .rejects.toMatchObject({ code: 'DISALLOWED_HOST' });
    expect(called).toBe(false);
  });

  it('extracts title, summary, published time, and body from meta + article', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="My News Title">
        <meta property="og:description" content="A short summary.">
        <meta property="article:published_time" content="2026-08-01T09:00:00Z">
      </head><body><article>The full body text.</article></body></html>`;
    const out = await fetchNewsDetail('https://news.sap.com/post/', {
      fetchImpl: okFetch(html),
      now: 1_700_000_000_000,
    });
    expect(out.title).toBe('My News Title');
    expect(out.summary).toBe('A short summary.');
    expect(out.publishedAt).toBe('2026-08-01T09:00:00Z');
    expect(out.content).toContain('The full body text.');
    expect(out.url).toBe('https://news.sap.com/post/');
    expect(out.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('caches by URL within the TTL (no second fetch)', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, status: 200, text: async () => '<article>x</article>' }; };
    const url = 'https://community.sap.com/post/';
    await fetchNewsDetail(url, { fetchImpl, now: 1000 });
    await fetchNewsDetail(url, { fetchImpl, now: 2000 });
    expect(calls).toBe(1);
  });

  it('throws UPSTREAM_ERROR on a non-ok response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
    await expect(fetchNewsDetail('https://news.sap.com/post/', { fetchImpl }))
      .rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
