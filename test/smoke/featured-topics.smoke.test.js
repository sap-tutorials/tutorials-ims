// test/smoke/featured-topics.smoke.test.js
//
// Smoke tests for issue #1032 — featured missions topic-based carousel.
//
// Skips when SMOKE_SRV_URL / SMOKE_BASE_URL env vars are not set
// (per project convention — mirrors advocates.smoke.test.js).
//
// Tests:
//   1. /homepage/featuredTopics() is reachable, returns JSON with snapshot + etag.
//   2. ETag + 304 round-trip.
//   3. All mission slugs in the snapshot are lowercase canonical.
//   4. The featured-topics Vue island bundle is served at /js/featured-topics-carousel.js.

import { describe, it, expect } from 'vitest';

const SRV  = process.env.SMOKE_SRV_URL;
const BASE = process.env.SMOKE_BASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime API smoke
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SRV)('GET /homepage/featuredTopics() smoke (#1032)', () => {
  it('returns 200 JSON with snapshot and etag', async () => {
    const res = await fetch(`${SRV}/homepage/featuredTopics()`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = await res.json();
    expect(body).toHaveProperty('snapshot');
    expect(body).toHaveProperty('etag');
    expect(Array.isArray(body.snapshot)).toBe(true);
  });

  it('responds with an ETag header', async () => {
    const res = await fetch(`${SRV}/homepage/featuredTopics()`);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('returns 304 on If-None-Match round-trip', async () => {
    const first = await fetch(`${SRV}/homepage/featuredTopics()`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await fetch(`${SRV}/homepage/featuredTopics()`, {
      headers: { 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('all conceptSlugs and mission slugs in the snapshot are lowercase canonical', async () => {
    const res = await fetch(`${SRV}/homepage/featuredTopics()`);
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const slide of body.snapshot || []) {
      expect(slide.conceptSlug).toBe(slide.conceptSlug.toLowerCase());
      for (const m of slide.missions || []) {
        expect(m.slug).toBe(m.slug.toLowerCase());
      }
    }
  });

  it('mission slugs in the first two slides resolve to real pages (HEAD ≤ 399)', async () => {
    const res = await fetch(`${SRV}/homepage/featuredTopics()`);
    const body = await res.json();
    for (const slide of (body.snapshot || []).slice(0, 2)) {
      for (const m of (slide.missions || []).slice(0, 1)) {
        // Missions can be tutorials (/tutorials/<slug>/) or missions (/tutorials/mission-<slug>/).
        // Try the href provided by the API first (if present).
        const href = m.href || `/tutorials/${m.slug}`;
        const base = BASE || SRV.replace(/\/+$/, '').replace(/:\d+$/, '');
        const url = href.startsWith('http') ? href : `${base}${href}`;
        const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        expect(head.status).toBeGreaterThanOrEqual(200);
        expect(head.status).toBeLessThan(400);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static asset smoke — Vue island bundle
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!BASE)('GET /js/featured-topics-carousel.js bundle smoke (#1032)', () => {
  it('is served with 200 and JS content-type', async () => {
    const res = await fetch(`${BASE}/js/featured-topics-carousel.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Homepage HTML smoke — carousel mount point present
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!BASE)('Homepage HTML includes featured-topics carousel mount (#1032)', () => {
  it('homepage / contains the featured-topics-carousel mount element or script tag', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Either the SSR partial rendered the mount div, or the island script tag is present.
    const hasMountPoint = /id=["']?featured-topics-carousel["']?/.test(html)
      || /featured-topics-carousel\.js/.test(html);
    expect(hasMountPoint).toBe(true);
  });
});
