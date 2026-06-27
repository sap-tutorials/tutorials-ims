// test/hybrid/explore-data-route.test.js
//
// Hybrid test: probe GET /graph/explore-data against the running CAP srv
// (typically `cds bind --exec -- npm run dev` against DEV HANA).
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

import { describe, it, beforeAll, expect } from 'vitest';

describe('/graph/explore-data (HTTP)', () => {
  let baseUrl;
  beforeAll(() => {
    baseUrl = process.env.HYBRID_SRV_URL ?? 'http://localhost:4004';
  });

  it('returns 200 with nodes + edges + generatedAt', async () => {
    const r = await fetch(`${baseUrl}/graph/explore-data`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('edges');
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body).toHaveProperty('generatedAt');
    expect(typeof body.generatedAt).toBe('string');
  });

  it('cache header reflects HIT on second call within 5 minutes', async () => {
    const r1 = await fetch(`${baseUrl}/graph/explore-data`);
    expect(r1.headers.get('x-cache')).toBeTruthy();
    const r2 = await fetch(`${baseUrl}/graph/explore-data`);
    expect(r2.headers.get('x-cache')).toBe('HIT');
  });

  it('coCompletedWith edges must satisfy k-anonymity (count, if present, divisible by 10 and >= 10)', async () => {
    const r = await fetch(`${baseUrl}/graph/explore-data`);
    const { edges } = await r.json();
    const coEdges = edges.filter((e) => e.p === 'coCompletedWith');
    for (const e of coEdges) {
      if ('count' in e) {
        expect(e.count % 10).toBe(0);
        expect(e.count).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('does not require auth', async () => {
    const r = await fetch(`${baseUrl}/graph/explore-data`, { headers: {} });
    expect(r.status).toBe(200);
  });
});
