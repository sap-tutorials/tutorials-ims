// test/hybrid/explore-data-route.test.js
//
// Hybrid HTTP test for GET /graph/explore-data — public, unauthenticated.
//
// Mirrors the Track 3-A pattern in test/hybrid/build-concepts.test.js:
// boots an in-process CAP server via `cds.test('serve', ...)` so the test
// is self-contained — no external `cds bind --exec -- npm run dev` required.
//
// Run with: npm run test:hybrid -- test/hybrid/explore-data-route.test.js
// Requires: `cf login` to a HANA-bound CF space first.
//
// Asserts:
//   - 200 + {nodes, edges, generatedAt} shape.
//   - X-Cache header reflects MISS → HIT within the 5-min TTL.
//   - No auth required.
//   - k-anonymity invariant: any coCompletedWith edge that surfaces a
//     count field has count % 10 === 0 and count >= 10. (Current shape
//     has no count, so this is a pure forward-compat guard.)
//
// Issue #446, Phase 3 Track 3-B PR 4/9.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Boot the CAP server bound to hybrid HANA. The returned object exposes
// an axios-like .get/.post interface ({status, headers, data}).
const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('/graph/explore-data (HTTP)', () => {
  it('returns 200 with nodes + edges + generatedAt', async () => {
    const r = await project.get('/graph/explore-data');
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('nodes');
    expect(r.data).toHaveProperty('edges');
    expect(Array.isArray(r.data.nodes)).toBe(true);
    expect(Array.isArray(r.data.edges)).toBe(true);
    expect(r.data).toHaveProperty('generatedAt');
    expect(typeof r.data.generatedAt).toBe('string');
  });

  it('cache header reflects HIT on second call within 5 minutes', async () => {
    const r1 = await project.get('/graph/explore-data');
    // axios shape: headers is a plain object with lowercase keys.
    expect(r1.headers['x-cache']).toBeTruthy();
    const r2 = await project.get('/graph/explore-data');
    expect(r2.headers['x-cache']).toBe('HIT');
  });

  it('coCompletedWith edges must satisfy k-anonymity (count, if present, divisible by 10 and >= 10)', async () => {
    const r = await project.get('/graph/explore-data');
    const coEdges = r.data.edges.filter((e) => e.p === 'coCompletedWith');
    for (const e of coEdges) {
      if ('count' in e) {
        expect(e.count % 10).toBe(0);
        expect(e.count).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('does not require auth', async () => {
    const r = await project.get('/graph/explore-data');
    expect(r.status).toBe(200);
  });

  it('sets Cache-Control: public, max-age=300', async () => {
    const r = await project.get('/graph/explore-data');
    expect(r.headers['cache-control']).toContain('max-age=300');
  });
});
