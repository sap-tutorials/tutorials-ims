// Smoke tests against the deployed approuter — runs post-deploy.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §5
//
// SMOKE_BASE_URL must point at the approuter (e.g.
//   https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com)
//
// "Passes-today / asserts-tomorrow" pattern from test/smoke/health.test.js:
// conditional assertions return early when no advocates are linked yet
// (initial state post-deploy). Once admins link an advocate via /admin-ui/,
// the assertions take effect on the next smoke run.

import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const skipIfNoUrl = BASE ? describe : describe.skip;

skipIfNoUrl('/api/advocates smoke — user-link', () => {
  let body;

  it('returns 200 and a JSON object with an advocates array', async () => {
    const res = await fetch(`${BASE}/api/advocates`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    body = await res.json();
    expect(Array.isArray(body.advocates)).toBe(true);
  });

  it('IF any advocate is linked, its email is a string', async () => {
    const linked = body.advocates.filter((a) => 'email' in a);
    if (linked.length === 0) {
      // Pre-link state: pass without asserting. Once admins link an
      // advocate, this assertion takes effect on the next smoke run.
      return;
    }
    for (const a of linked) {
      expect(typeof a.email).toBe('string');
      expect(a.email).toMatch(/.+@.+/);
    }
  });

  it('IF any advocate has authoredTutorials, each entry has slug + title', async () => {
    const withAuthored = body.advocates.filter((a) => 'authoredTutorials' in a);
    if (withAuthored.length === 0) return;
    for (const a of withAuthored) {
      expect(Array.isArray(a.authoredTutorials)).toBe(true);
      for (const t of a.authoredTutorials) {
        expect(typeof t.slug).toBe('string');
        expect(typeof t.title).toBe('string');
      }
    }
  });

  it('response shape is internally consistent for every advocate', async () => {
    // No advocate should have email/tutorials without being linked. We can't
    // see user_ID from the public endpoint (correctly — it's not part of
    // the public shape), but we can check that emails/tutorials don't
    // appear for advocates lacking ANY linked-data field.
    // This is a tautology today (the server-side gate already enforces it),
    // but it catches a future regression where someone returns null instead
    // of omitting the field.
    for (const a of body.advocates) {
      if (a.email !== undefined) {
        expect(typeof a.email).toBe('string');
        expect(a.email.length).toBeGreaterThan(0);
      }
      if (a.authoredTutorials !== undefined) {
        expect(Array.isArray(a.authoredTutorials)).toBe(true);
        expect(a.authoredTutorials.length).toBeGreaterThan(0);
      }
      if (a.contributedTutorials !== undefined) {
        expect(Array.isArray(a.contributedTutorials)).toBe(true);
        expect(a.contributedTutorials.length).toBeGreaterThan(0);
      }
    }
  });
});
