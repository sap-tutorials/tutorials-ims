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
});
