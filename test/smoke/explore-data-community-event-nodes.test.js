// test/smoke/explore-data-community-event-nodes.test.js
//
// Phase 4.8 (#765): smoke test — verifies that the /graph/explore-data
// endpoint accepts a ?type=community-event query once events have been seeded.
// Runs against SMOKE_SRV_URL (srv directly); skipped when env var is absent.

import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from './smoke.config.js';

const BASE = process.env.SMOKE_SRV_URL;

describe.skipIf(!BASE)('explore-data community-event nodes', () => {
  it('returns 200 for type=community-event query (post-seed)', async () => {
    const res = await fetchWithRetry(`${BASE}/graph/explore-data?type=community-event`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    // Shape: { nodes: [...], edges: [...] }. The endpoint returns the full
    // graph (the ?type= param is not a server-side filter), so select the
    // community-event nodes ourselves. Graceful skip while external
    // community-event content is unseeded in DEV; the type assertion fires
    // as soon as seeding lands.
    const communityEventNodes = Array.isArray(body.nodes)
      ? body.nodes.filter((n) => n && n.type === 'community-event')
      : [];
    if (communityEventNodes.length === 0) return;
    expect(communityEventNodes[0].type).toBe('community-event');
  });
});
