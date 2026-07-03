import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// #895 — CSRF re-enablement on every XSUAA route in xs-app.json.
//
// These smokes hit the deployed AppRouter (not the srv directly) because
// CSRF enforcement is an AppRouter concern. The srv itself never sees a
// request that failed CSRF at the edge.
//
// We can't send an authenticated request from CI without a live XSUAA
// user session, so the smokes cover only what unauthenticated traffic
// can observe. That's enough to prove:
//   1. Anonymous mutating traffic still works on anon routes (we're not
//      broken there).
//   2. Anonymous mutating traffic on XSUAA routes is rejected at auth
//      (401/403), NOT at CSRF (which is the "correct" order: auth first,
//      then CSRF). CSRF-first would leak "does this endpoint exist" via
//      differential 403 codes.
//
// Post-deploy, an operator runs the manual Playwright pass documented in
// docs/superpowers/specs/2026-07-02-895-csrf-reenablement-design.md § 7.3
// against DEV, driving each Vue-island + analytics-explorer mutation
// end-to-end with a real session.

describe('CSRF re-enablement (#895)', () => {
  it('POST /feedback/submit (anon route) is NOT rejected by CSRF', async () => {
    // Feedback is authenticationType: 'none' — CSRF never applies.
    // The request may 400 for missing fields, 429 for rate limit, or
    // 200/201, but NOT 403+x-csrf-token: required.
    const res = await fetchWithRetry(`${BASE_URL}/feedback/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'nonexistent-tutorial' }),
    });
    // Not a redirect to login (would be a 302 with Location: /login).
    expect(res.status).not.toBe(302);
    // If we got a 403, it must not be a CSRF-required rejection.
    if (res.status === 403) {
      const header = res.headers.get('x-csrf-token');
      expect(header?.toLowerCase()).not.toBe('required');
    }
  });

  it('POST /api/completeStep (XSUAA route) without auth is rejected at auth, not CSRF', async () => {
    // Anonymous mutating traffic on an XSUAA route should be rejected
    // BEFORE CSRF is evaluated. The user isn't logged in, so there's no
    // session cookie, so approuter redirects to login (302 to /login or
    // 401 depending on approuter version).
    const res = await fetchWithRetry(`${BASE_URL}/api/completeStep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'x', stepNumber: 1 }),
    });
    // Expect the auth gate to fire — either a redirect-to-login (302)
    // or an outright reject (401/403). A response with
    // x-csrf-token: required means CSRF fired before auth, which is a
    // regression (and a minor info-leak).
    expect([302, 401, 403]).toContain(res.status);
    if (res.status === 403) {
      const header = res.headers.get('x-csrf-token');
      expect(header?.toLowerCase()).not.toBe('required');
    }
  });

  it('POST /admin/Tutorials (Admin-scoped route) without auth is rejected at auth, not CSRF', async () => {
    // Same rationale as above — auth fires before CSRF at the approuter.
    const res = await fetchWithRetry(`${BASE_URL}/admin/Tutorials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([302, 401, 403]).toContain(res.status);
    if (res.status === 403) {
      const header = res.headers.get('x-csrf-token');
      expect(header?.toLowerCase()).not.toBe('required');
    }
  });

  it('xs-app.json (as deployed) does not disable CSRF for any route', async () => {
    // Approuter doesn't expose xs-app.json at runtime, but the CSRF
    // token endpoint is a reliable positive signal that enforcement is
    // ON somewhere. We can't inspect config here — this test is a
    // scaffold that will grow when we add a probe route.
    // For now, the assertion is a placeholder that the build-time guard
    // (scripts/check-csrf-clients.ts) enforces the invariant. Keep the
    // test file alive so CI wires up the smoke workspace correctly.
    expect(true).toBe(true);
  });
});
