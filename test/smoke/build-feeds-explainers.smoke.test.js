// test/smoke/build-feeds-explainers.smoke.test.js
//
// #759 PR 1 — smoke tests for the two new build feeds and the extended
// HomepageShelves payload.
//
// Verifies that the deployed srv actually serves:
//   1. /build/verb-definitions — 200, 6 verbs, 60s Cache-Control.
//   2. /build/shelf-definitions — 200, 4 shelves.
//   3. /build/homepage-shelves — each row carries the new tagline,
//      whyItMatters, and authoringStatus fields.
//
// Catches deployment-skew (MTA module didn't ship updated srv binary)
// that unit + hybrid tests can't see.

import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Smoke — build feeds for homepage explainers (#759 PR 1)', () => {
  describe('/build/verb-definitions', () => {
    it('returns 200 with 6 verbs', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/build/verb-definitions`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = await res.json();
      expect(Array.isArray(body.verbs)).toBe(true);
      expect(body.verbs.length).toBe(6);
    });

    it('sets 60s Cache-Control', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/build/verb-definitions`);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    });
  });

  describe('/build/shelf-definitions', () => {
    it('returns 200 with 4 shelves', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/build/shelf-definitions`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = await res.json();
      expect(Array.isArray(body.shelves)).toBe(true);
      expect(body.shelves.length).toBe(4);
    });
  });

  describe('/build/homepage-shelves — extended payload (#759)', () => {
    it('rows include tagline/whyItMatters/authoringStatus fields', async (ctx) => {
      const res = await fetchWithRetry(`${SRV_URL}/build/homepage-shelves`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.shelves)).toBe(true);
      if (body.shelves.length === 0) {
        // Visible skip — surfaces in CI distinct from a silent PASS.
        // Avoids false failures in envs where HomepageShelves isn't seeded.
        ctx.skip();
        return;
      }
      const row = body.shelves[0];
      // Field may be null but the property MUST exist after JSON serialisation.
      expect('tagline' in row).toBe(true);
      expect('whyItMatters' in row).toBe(true);
      expect('authoringStatus' in row).toBe(true);
    });
  });
});
