import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// #446 Track 3-B Task 3 — /explore/ CAP-rendered shell smoke test.
//
// Catches the class of bugs where the HTML references asset URLs that the
// approuter can't serve (e.g. hardcoded /assets/index.css that misses Vite's
// content-hashed filenames). Verifies that:
//   1. /explore/ returns 200 HTML
//   2. The inline JSON block is present and valid JSON with the expected shape
//   3. The referenced JS bundle (main-<hash>.js) is reachable
//   4. The referenced CSS file (assets/index-<hash>.css) is reachable

describe('/explore/ route', () => {
  let html = null;

  it('returns 200 with valid HTML containing the inline graph JSON', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/explore/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    html = await r.text();
    expect(html).toContain('<script type="application/json" id="initial-graph">');
    const match = html.match(/<script type="application\/json" id="initial-graph">([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    const json = JSON.parse(match[1]);
    expect(json).toHaveProperty('nodes');
    expect(json).toHaveProperty('edges');
    expect(json).toHaveProperty('generatedAt');
  });

  it('references a real JS bundle (main-<hash>.js) that returns 200', async () => {
    if (!html) {
      const r = await fetchWithRetry(`${BASE_URL}/explore/`);
      html = await r.text();
    }
    const jsMatch = html.match(/\/explore-ui\/main-[a-zA-Z0-9_-]+\.js/);
    expect(jsMatch).toBeTruthy();
    const r = await fetchWithRetry(`${BASE_URL}${jsMatch[0]}`, { method: 'HEAD' });
    expect(r.status).toBe(200);
  });

  it('references a real CSS file that returns 200', async () => {
    if (!html) {
      const r = await fetchWithRetry(`${BASE_URL}/explore/`);
      html = await r.text();
    }
    const cssMatch = html.match(/\/explore-ui\/assets\/index-[a-zA-Z0-9_-]+\.css/);
    expect(cssMatch).toBeTruthy();
    const r = await fetchWithRetry(`${BASE_URL}${cssMatch[0]}`, { method: 'HEAD' });
    expect(r.status).toBe(200);
  });
});
