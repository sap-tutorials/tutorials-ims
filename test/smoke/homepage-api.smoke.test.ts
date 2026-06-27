// test/smoke/homepage-api.smoke.test.ts
//
// Issue #639 — Phase 4 homepage cutover.
// Verifies that the HomepageService API endpoints are live and return
// the expected shapes after deploy.
//
// URL spelling: CDS function names map verbatim to the URL path.
// HomepageService exposes `function communityBlogs()` (camelCase) in
// srv/homepage-service.cds, so the URL is /api/homepage/communityBlogs.
//
// All assertions are shape-only (Array.isArray / typeof === 'object') so
// the suite stays green on a fresh deploy before any content is published
// or fetched from external feeds.
//
// The describe gates on SMOKE_SRV_URL so the suite skips cleanly when
// the env var is absent (CI sets it after deploy).

import { describe, expect, it } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;

describe.skipIf(!SRV)('Homepage API smoke', () => {
  it.each([
    ['/api/homepage/events',          'array'],
    ['/api/homepage/videos',          'object'],
    ['/api/homepage/communityBlogs',  'array'],
    ['/api/homepage/news',            'array'],
    ['/api/homepage/shelves?verb=LEARN', 'array'],
    ['/api/homepage/redirectsActive', 'array']
  ])('GET %s returns %s', async (path, kind) => {
    const res = await fetch(SRV + path);
    expect(res.ok).toBe(true);
    const data = await res.json();
    if (kind === 'array') expect(Array.isArray(data)).toBe(true);
    else expect(typeof data).toBe('object');
  });

  it('GET /build/homepage-shelves returns shelves + buildAt', async () => {
    const res = await fetch(SRV + '/build/homepage-shelves');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.shelves)).toBe(true);
    expect(data.buildAt).toBeTruthy();
  });
});
