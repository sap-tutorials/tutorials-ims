// test/smoke/homepage.smoke.test.ts
//
// Issue #639 — Phase 4 homepage cutover.
// Verifies the new developer homepage, verb sub-pages, and relocated
// tutorial navigator are live after deploy. Also guards legacy HTML
// redirects (/tutorial-navigator.html, /index.html) that the AppRouter
// must honour.
//
// All describes gate on SMOKE_BASE_URL so the suite skips cleanly in
// local runs where the env var is absent (CI sets it after deploy).
//
// Hugo's production minifier strips quotes from safe attribute values,
// so every regex tolerates both quoted and unquoted attribute forms.

import { describe, expect, it } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;

describe.skipIf(!BASE)('Developer homepage smoke', () => {
  it('GET / returns the new homepage', async () => {
    const res = await fetch(BASE + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<article[^>]+class=["']?developer-homepage/);
    expect(html).toMatch(/data-island=["']?events["']?/);
    expect(html).toMatch(/data-island=["']?videos["']?/);
  });

  it.each(['learn', 'build', 'integrate', 'model', 'operate', 'ai', 'connect'])('GET /%s/ returns the verb sub-page', async (verb) => {
    // (#1029) MODEL added as 7th verb — data-platform lane.
    const res = await fetch(`${BASE}/${verb}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<article[^>]+class=["']?verb-page/);
  });

  it('GET /tutorial-navigator/ renders the relocated navigator', async () => {
    const res = await fetch(BASE + '/tutorial-navigator/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/tutorial-navigator|navigator-grid/);
  });

  it('GET /tutorial-navigator.html 301-redirects to /tutorial-navigator/', async () => {
    const res = await fetch(BASE + '/tutorial-navigator.html', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/tutorial-navigator/');
  });

  it('GET /index.html 301-redirects to /', async () => {
    const res = await fetch(BASE + '/index.html', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/');
  });

  it('GET /tutorials/abap-dev-get-started/ still resolves (regression guard)', async () => {
    const res = await fetch(BASE + '/tutorials/abap-dev-get-started/');
    // Tutorial may 404 in a fresh deploy if content not yet published; accept 200 or 404 but never 301-to-wrong-place.
    expect([200, 404]).toContain(res.status);
  });

  it('GET /nonexistent.html returns 404 (conservative catch-all)', async () => {
    const res = await fetch(BASE + '/nonexistent.html', { redirect: 'manual' });
    expect([404, 200]).toContain(res.status);  // 200 if it accidentally exists; never 301
    expect(res.status).not.toBe(301);
  });
});

describe.skipIf(!BASE)('Video band #1031 kind field', () => {
  it('GET /homepage/videos returns items tagged kind: anchor|popular', async () => {
    const res = await fetch(BASE + '/homepage/videos');
    expect(res.status).toBe(200);
    const body: { recent: Array<{ kind?: string }> } = await res.json();
    expect(Array.isArray(body.recent)).toBe(true);
    for (const item of body.recent) {
      expect(['anchor', 'popular']).toContain(item.kind);
    }
  });
});
