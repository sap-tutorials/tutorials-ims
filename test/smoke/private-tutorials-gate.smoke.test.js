// test/smoke/private-tutorials-gate.smoke.test.js
// Post-deploy smoke assertions for the ROLE_GATED tutorial serve gate (#3099).
//
// Requires a ROLE_GATED tutorial to exist in the deployed env — set
// SMOKE_GATED_SLUG to the slug of a tutorial with visibility=ROLE_GATED.
//
// Self-skips when SMOKE_BASE_URL is unset (CI runs it post-deploy only).
// SMOKE_GATED_SLUG is required inside the suite; if unset, all inner
// tests are skipped via a secondary skipIf guard.
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

const GATED_SLUG = process.env.SMOKE_GATED_SLUG;

describe.skipIf(!process.env.SMOKE_BASE_URL)('ROLE_GATED tutorial serve gate (#3099)', () => {

  // Guard: a ROLE_GATED slug must be provided; skip gracefully if not.
  describe.skipIf(!GATED_SLUG)('with SMOKE_GATED_SLUG set', () => {

    // ── Gate: /tutorials-prerelease/<slug> without the Tutorial.PreRelease scope ──
    // The approuter route for /tutorials-prerelease/* requires $XSAPPNAME.Tutorial.PreRelease.
    // An unauthenticated call must be rejected — 401 (not yet authed) or 403 (authed,
    // wrong scope). The approuter redirects to login (302) for browser flows, so we
    // also accept 302.
    it('GET /tutorials-prerelease/<slug> without auth → 401/403/302 (scope gate)', async () => {
      const url = `${BASE_URL}/tutorials-prerelease/${GATED_SLUG}/`;
      const res = await fetchWithRetry(url);
      // approuter scope gate: 401 (no token), 403 (wrong scope), or 302 (login redirect)
      expect([401, 403, 302], `expected auth rejection, got ${res.status} for ${url}`)
        .toContain(res.status);
    });

    // ── Public route: /tutorials/<slug> for a ROLE_GATED tutorial must return 404 ──
    // The serve gate in srv/lib/content-store.js (Task 6) returns 404 on the public
    // route for any tutorial whose visibility === 'ROLE_GATED' — it must not be served
    // on the unauthenticated channel.
    it('GET /tutorials/<slug> for a ROLE_GATED tutorial → 404 (not served on public route)', async () => {
      const url = `${BASE_URL}/tutorials/${GATED_SLUG}/`;
      const res = await fetchWithRetry(url);
      expect(res.status, `ROLE_GATED tutorial must not be served on public route: ${url}`)
        .toBe(404);
    });
  });

  // ── Structural guard (no slug needed): /tutorials-prerelease/ as a path is locked ──
  // The /tutorials-prerelease/ prefix must require auth even without a known slug.
  // Test with a non-existent sentinel slug to confirm the route is scope-gated before
  // the backend is reached.
  it('GET /tutorials-prerelease/__smoke__sentinel without auth → 401/403/302', async () => {
    const url = `${BASE_URL}/tutorials-prerelease/__smoke__sentinel/`;
    const res = await fetchWithRetry(url);
    expect([401, 403, 302], `prerelease route must be scope-gated, got ${res.status}`)
      .toContain(res.status);
  });
});
