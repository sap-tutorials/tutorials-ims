import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

// #744 — /explore/ end-to-end smoke test.
//
// Post-#744 the page is Hugo-rendered with full chrome (shellbar + theme)
// and the Vue/Sigma SPA fetches graph data client-side from /graph/explore-data.
// Assertions:
//   1. /explore/ returns 200 HTML with shellbar + theme markup + #explore-app mount.
//   2. The referenced JS bundle resolves to 200.
//   3. The referenced CSS file resolves to 200.
//   4. /graph/explore-data returns the bulk payload.
//   5. /graph/path returns 200 for a real edge pair (skipped if empty env).
//   6. /graph/path returns 400 for same-slug query.

describe('/explore/ route', () => {
  let html = null;

  it('returns 200 with shellbar + theme markup (Hugo-rendered chrome)', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/explore/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    html = await r.text();
    // Section 5.2 of the spec: assert the shellbar + theme markup so a
    // regression that re-introduces a standalone template fails loudly.
    expect(html).toContain('app-shellbar');
    expect(html).toMatch(/data-theme=/);
    // The Vue island mount point (Task 6 renamed #app → #explore-app).
    expect(html).toMatch(/id="?explore-app"?/);
    // Defensive: confirm the OLD SSR script-tag JSON shape is GONE.
    expect(html).not.toContain('<script type="application/json" id="initial-graph">');
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
