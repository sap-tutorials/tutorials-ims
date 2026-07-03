// test/smoke/explore-data-community-event-nodes.test.js
//
// Phase 4.8 (#765): smoke test — verifies that the /graph/explore-data
// endpoint accepts a ?type=community-event query once events have been seeded.
// Runs against SMOKE_SRV_URL (srv directly); skipped when env var is absent.

import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;

describe.skipIf(!BASE)('explore-data community-event nodes', () => {
  it('returns 200 for type=community-event query (post-seed)', async () => {
    const res = await fetch(`${BASE}/graph/explore-data?type=community-event`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    // Shape: { nodes: [...], edges: [...] } — accept 0 or more nodes;
    // assert the query returns 200 and any returned node has the correct type.
    if (Array.isArray(body.nodes) && body.nodes.length > 0) {
      expect(body.nodes[0].type).toBe('community-event');
    }
  });
});
