import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

let tutorialPath = '/tutorials/abap-cloud-ui-from-interface/';

beforeAll(async () => {
  try {
    const res = await fetchWithRetry(`${BASE_URL}/llms.txt`);
    if (res.ok) {
      const text = await res.text();
      const m = text.match(/\((https?:\/\/developers\.sap\.com\/tutorials\/[^)]+)\)/);
      if (m) {
        const u = new URL(m[1]);
        tutorialPath = u.pathname;
      }
    }
  } catch {}
});

describe('Meta tags — homepage', () => {
  let html;
  it('fetches', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    html = await res.text();
  });

  it('has correct title (no duplication)', () => {
    expect(html).toMatch(/<title>SAP Developers Tutorials<\/title>/);
  });

  it('has canonical, description, robots, content-signal', () => {
    expect(html).toMatch(/<link rel="canonical" href="https:\/\/developers\.sap\.com\/"/);
    expect(html).toMatch(/<meta name="description" content="[^"]+"/);
    expect(html).toMatch(/<meta name="robots" content="[^"]*max-image-preview:large[^"]*"/);
    expect(html).toMatch(/<meta name="content-signal" content="index=yes, ai-train=no, ai-search=yes"/);
  });

  it('has Open Graph + Twitter Card', () => {
    expect(html).toMatch(/<meta property="og:site_name" content="SAP Developers Tutorials"/);
    expect(html).toMatch(/<meta property="og:url" content="https:\/\/developers\.sap\.com\/"/);
    expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
    expect(html).toMatch(/<meta name="twitter:site" content="@sapdevs"/);
  });
});

describe('Meta tags — tutorial page', () => {
  let html;
  it('fetches', async () => {
    const res = await fetchWithRetry(`${BASE_URL}${tutorialPath}`);
    expect(res.status).toBe(200);
    html = await res.text();
  });

  it('has " | SAP Developers Tutorials" suffix in title', () => {
    expect(html).toMatch(/<title>[^<]+ \| SAP Developers Tutorials<\/title>/);
  });

  it('has og:type=article and article metadata', () => {
    expect(html).toMatch(/<meta property="og:type" content="article"/);
  });

  it('has author meta tag', () => {
    expect(html).toMatch(/<meta name="author" content="[^"]+"/);
  });
});
