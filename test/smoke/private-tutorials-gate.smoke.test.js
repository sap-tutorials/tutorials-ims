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

// This deployment's approuter enforces XSUAA by returning a 200 HTML *login
// interstitial* (the fragmentAfterLogin / locationAfterLogin cookie shim) for
// an unauthenticated request to a protected route — NOT a 302/401/403. (Same
// behavior the admin-shell + /me smoke tests document.) So "gated" means: the
// caller never receives the protected CONTENT. A 200 is acceptable ONLY when
// the body is that interstitial; a 200 carrying real content is the breach.
// assertGated accepts 302/401/403, or 200-as-interstitial, and fails on a 200
// whose body is NOT the interstitial (i.e. content leaked past the gate).
async function assertGated(url) {
  const res = await fetchWithRetry(url);
  if ([302, 401, 403].includes(res.status)) return;
  const body = res.status === 200 ? await res.text() : '';
  const isLoginInterstitial = /fragmentAfterLogin|locationAfterLogin/.test(body);
  expect(
    isLoginInterstitial,
    `prerelease route must be scope-gated: got ${res.status} and the body was ` +
    `NOT the XSUAA login interstitial for ${url} — pre-release content may have leaked`,
  ).toBe(true);
}

describe.skipIf(!process.env.SMOKE_BASE_URL)('ROLE_GATED tutorial serve gate (#3099)', () => {

  // Guard: a ROLE_GATED slug must be provided; skip gracefully if not.
  describe.skipIf(!GATED_SLUG)('with SMOKE_GATED_SLUG set', () => {

    // ── Gate: /tutorials-prerelease/<slug> without the Tutorial.PreRelease scope ──
    // The approuter route for /tutorials-prerelease/* requires $XSAPPNAME.Tutorial.PreRelease.
    // An unauthenticated call must not receive pre-release content — it gets a
    // 302/401/403, or the 200 XSUAA login interstitial (see assertGated).
    it('GET /tutorials-prerelease/<slug> without auth → gated (no content leak)', async () => {
      await assertGated(`${BASE_URL}/tutorials-prerelease/${GATED_SLUG}/`);
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
  it('GET /tutorials-prerelease/__smoke__sentinel without auth → gated (no content leak)', async () => {
    await assertGated(`${BASE_URL}/tutorials-prerelease/__smoke__sentinel/`);
  });
});
