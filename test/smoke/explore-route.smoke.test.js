import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

// #446 Track 3-B — /explore/ end-to-end smoke test.
//
// Task 3 (CSS-discovery) verified that the HTML page references hashed JS/CSS
// asset URLs the approuter can actually serve. Task 6 extends this to the
// underlying CAP endpoints that power the page:
//   1. /explore/ returns 200 HTML with inline graph JSON.
//   2. The referenced JS bundle resolves to 200.
//   3. The referenced CSS file resolves to 200.
//   4. /graph/explore-data returns the bulk payload.
//   5. /graph/path returns 200 for a real edge pair (skipped if empty env).
//   6. /graph/path returns 400 for same-slug query (extracted from Phase 2).

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

  it('returns 200 for /graph/explore-data with valid payload', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/graph/explore-data`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('edges');
  });

  it('returns 200 for /graph/path with a real edge pair', async (ctx) => {
    const probe = await fetchWithRetry(`${SRV_URL}/graph/explore-data`);
    if (!probe || !probe.ok) return ctx.skip();
    const { nodes, edges } = await probe.json();
    const edge = edges.find(e => {
      const s = nodes.find(n => n.id === e.s)?.slug;
      const o = nodes.find(n => n.id === e.o)?.slug;
      return s && o && /^[a-z0-9-]+$/.test(s) && /^[a-z0-9-]+$/.test(o) && s !== o;
    });
    if (!edge) return ctx.skip();  // empty-env or no slug-bearing edges
    const from = nodes.find(n => n.id === edge.s).slug;
    const to = nodes.find(n => n.id === edge.o).slug;
    const r = await fetchWithRetry(`${SRV_URL}/graph/path?from=${from}&to=${to}`);
    expect(r.status).toBe(200);
  });

  it('returns 400 for /graph/path with same slug', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/graph/path?from=cap&to=cap`);
    expect(r.status).toBe(400);
  });
});
