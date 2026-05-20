import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { blocks.push(JSON.parse(m[1])); } catch {}
  }
  return blocks;
}

function findType(blocks, type) {
  for (const b of blocks) {
    if (b['@type'] === type) return b;
    if (Array.isArray(b['@graph'])) {
      const hit = b['@graph'].find((g) => g['@type'] === type);
      if (hit) return hit;
    }
  }
  return null;
}

let tutorialPath = '/tutorials/abap-cloud-ui-from-interface/';
beforeAll(async () => {
  try {
    const res = await fetchWithRetry(`${BASE_URL}/llms.txt`);
    if (res.ok) {
      const text = await res.text();
      const m = text.match(/\((https?:\/\/developers\.sap\.com\/tutorials\/[^)]+)\)/);
      if (m) tutorialPath = new URL(m[1]).pathname;
    }
  } catch {}
});

describe('JSON-LD structured data', () => {
  it('homepage has Organization + WebSite', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    const html = await res.text();
    const blocks = extractJsonLd(html);
    expect(blocks.length).toBeGreaterThan(0);
    expect(findType(blocks, 'Organization')).toBeTruthy();
    expect(findType(blocks, 'WebSite')).toBeTruthy();
  });

  it('tutorial page has HowTo with steps and BreadcrumbList', async () => {
    const res = await fetchWithRetry(`${BASE_URL}${tutorialPath}`);
    const html = await res.text();
    const blocks = extractJsonLd(html);
    const howto = findType(blocks, 'HowTo');
    expect(howto).toBeTruthy();
    expect(howto.name).toBeTruthy();
    expect(Array.isArray(howto.step)).toBe(true);
    expect(howto.step.length).toBeGreaterThan(0);
    expect(findType(blocks, 'BreadcrumbList')).toBeTruthy();
  });
});
