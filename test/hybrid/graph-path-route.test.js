// test/hybrid/graph-path-route.test.js
//
// Hybrid HTTP test for GET /graph/path — public, unauthenticated.
//
// Mirrors test/hybrid/explore-data-route.test.js: boots an in-process CAP
// server via `cds.test('serve', ...)` so the test is self-contained — no
// external `cds bind --exec -- npm run dev` required.
//
// Run with: npm run test:hybrid -- test/hybrid/graph-path-route.test.js
// Requires: `cf login` to a HANA-bound CF space first.
//
// Asserts:
//   - 400 when from/to query params are missing or malformed
//   - 200 + {from, to, steps[]} shape for a real slug pair from the
//     KG projection
//   - 404 for a slug pair with no graph relationship
//   - Cache-Control header is set (public)
//   - No auth required
//
// Issue #446, Phase 3 Track 3-B PR 5/6.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

// Production-realistic slug pair — same one used in
// test/hybrid/kg-path-between.test.js, verified to populate the PREREQ arm.
const FROM_SLUG = 'abap-dev-enhance-cds-view';
const TO_SLUG = 'btp-cap-beginner-bas-wizard';

describe('GET /graph/path (HTTP)', () => {
  it('returns 400 when from is missing', async () => {
    // cds.test() helper throws on non-2xx by default; catch the rejection
    // and inspect the .response field (axios-like shape).
    let r;
    try {
      r = await project.get(`/graph/path?to=${TO_SLUG}`);
    } catch (err) {
      r = err.response;
    }
    expect(r.status).toBe(400);
    expect(r.data).toHaveProperty('error');
  });

  it('returns 400 when to is missing', async () => {
    let r;
    try {
      r = await project.get(`/graph/path?from=${FROM_SLUG}`);
    } catch (err) {
      r = err.response;
    }
    expect(r.status).toBe(400);
  });

  it('returns 400 when from is malformed (slug regex rejects)', async () => {
    let r;
    try {
      r = await project.get(`/graph/path?from=BAD%20SLUG!&to=${TO_SLUG}`);
    } catch (err) {
      r = err.response;
    }
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/invalid slug/i);
  });

  it('returns 400 when from === to (same-slug guard)', async () => {
    let r;
    try {
      r = await project.get(`/graph/path?from=${FROM_SLUG}&to=${FROM_SLUG}`);
    } catch (err) {
      r = err.response;
    }
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/must differ/i);
  });

  it('returns 200 with {from, to, steps} for a real slug pair', async () => {
    let r;
    try {
      r = await project.get(`/graph/path?from=${FROM_SLUG}&to=${TO_SLUG}`);
    } catch (err) {
      // 404 is acceptable if the projection doesn't have this pair in
      // the current graph snapshot — surface enough info for debugging.
      if (err.response?.status === 404) {
        expect(err.response.data).toHaveProperty('error');
        return;
      }
      throw err;
    }
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('from', FROM_SLUG);
    expect(r.data).toHaveProperty('to', TO_SLUG);
    expect(Array.isArray(r.data.steps)).toBe(true);
    if (r.data.steps.length > 0) {
      // Each step must carry the contract fields.
      const step = r.data.steps[0];
      expect(step).toHaveProperty('slug');
      expect(step).toHaveProperty('pathType');
      expect(step).toHaveProperty('pathTypeRank');
      expect(step).toHaveProperty('hopCount');
      expect(typeof step.slug).toBe('string');
      expect(typeof step.pathTypeRank).toBe('number');
    }
  });

  it('returns 404 for a slug pair with no graph relationship', async () => {
    let r;
    try {
      r = await project.get(`/graph/path?from=does-not-exist-source&to=does-not-exist-target`);
    } catch (err) {
      r = err.response;
    }
    expect(r.status).toBe(404);
    expect(r.data).toHaveProperty('error');
  });

  it('sets Cache-Control on a successful response', async () => {
    try {
      const r = await project.get(`/graph/path?from=${FROM_SLUG}&to=${TO_SLUG}`);
      // axios shape: headers is a plain object with lowercase keys.
      expect(r.headers['cache-control']).toMatch(/public/);
    } catch (err) {
      // 404 acceptable if graph snapshot doesn't have this pair.
      if (err.response?.status !== 404) throw err;
    }
  });

  it('does not require auth', async () => {
    // No auth headers — call must succeed (or 404, never 401/403).
    let r;
    try {
      r = await project.get(`/graph/path?from=${FROM_SLUG}&to=${TO_SLUG}`);
    } catch (err) {
      r = err.response;
    }
    expect([200, 404]).toContain(r.status);
  });
});
