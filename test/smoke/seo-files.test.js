import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('SEO files', () => {
  it('serves robots.txt with sitemap reference and AI bot allowlist', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/robots.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/Sitemap:\s+https?:\/\/.+\/sitemap\.xml/);
    expect(text).toMatch(/User-agent:\s+GPTBot/);
    expect(text).toMatch(/User-agent:\s+ClaudeBot/);
    expect(text).toMatch(/Disallow:\s+\/api\//);
  });

  it('serves sitemap.xml with absolute URLs and at least one <lastmod>', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/sitemap.xml`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<urlset');
    expect(text).toMatch(/<loc>https:\/\/developers\.sap\.com\//);
    expect(text).toMatch(/<lastmod>/);
  });

  it('301-redirects legacy AEM sitemap URLs to /sitemap.xml', async () => {
    // Intelligent Search's crawler was pinned to the legacy AEM /sitemap_index.xml
    // (+ /sitemap_<n>.xml shards); the platform now serves a single /sitemap.xml.
    // The approuter middleware keeps those legacy URLs alive via a 301.
    for (const legacy of ['/sitemap_index.xml', '/sitemap_1.xml']) {
      const res = await fetchWithRetry(`${BASE_URL}${legacy}`); // redirect: 'manual'
      expect(res.status, `${legacy} should 301`).toBe(301);
      expect(res.headers.get('location')).toMatch(/\/sitemap\.xml$/);
    }
  });

  it('serves llms.txt with brand header and citation policy', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/llms.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^# SAP Developers Tutorials/);
    expect(text).toMatch(/Content policy/);
  });

  it('serves llms-full.txt non-empty', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/llms-full.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(10000);
  });

  it('serves /AGENTS.md', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/AGENTS.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/AGENTS\.md.*Guidance for AI Agents/);
  });

  it('serves og-default image', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/img/og-default.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/png/);
  });

  it('serves /.well-known/security.txt (RFC 9116) with Contact + Expires', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/.well-known/security.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toMatch(/^Contact:\s+https?:\/\//m);
    expect(text).toMatch(/^Expires:\s+\d{4}-\d{2}-\d{2}T/m);
  });
});
