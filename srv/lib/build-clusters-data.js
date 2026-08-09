// srv/lib/build-clusters-data.js
//
// Express middleware backing GET /graph/clusters-data.
// Mirrors build-explore-data.js: 5-min in-process module cache, X-Cache HIT/MISS header,
// Cache-Control: public, max-age=300.
//
// Supports ?cluster=<slug> query parameter:
//   - Returns a subgraph (concept nodes + intra-cluster edges) for the given cluster.
//   - Slug validated against /^[a-z0-9][a-z0-9-]*$/ — 400 on bad input.
//   - Subgraph responses are NOT cached (cheap, per-cluster).
//
// Fail-open: any uncaught throw → 500 { error: 'clusters-data query failed' }.
// Island degrades gracefully (renders empty Sigma canvas).
//
// Issue: topics-discovery SDD Task 8

import cds from '@sap/cds';
import { buildClustersDataPayload, buildClusterSubgraph } from './kg-clusters-data.js';

const log = cds.log('build-clusters-data');

const TTL_MS = 5 * 60 * 1000;

let cached = null;
let cachedAt = 0;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function clustersDataHandler(req, res) {
  try {
    const db = await cds.connect.to('db');
    const clusterSlug =
      typeof req.query.cluster === 'string' ? req.query.cluster.toLowerCase() : '';

    if (clusterSlug) {
      if (!SLUG_RE.test(clusterSlug)) {
        return res.status(400).json({ error: 'bad cluster slug' });
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(await buildClusterSubgraph(db, clusterSlug));
    }

    // Super-graph branch — 5-min module cache
    const now = Date.now();
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (cached && now - cachedAt < TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
    cached = await buildClustersDataPayload(db);
    cachedAt = now;
    res.setHeader('X-Cache', 'MISS');
    return res.json(cached);
  } catch (err) {
    log.error('failed to build /graph/clusters-data payload', err);
    return res.status(500).json({ error: 'clusters-data query failed' });
  }
}

/**
 * Test-only: clear the module cache between test runs.
 * Not part of the public API.
 */
export function _resetClustersDataCache() {
  cached = null;
  cachedAt = 0;
}

export default { clustersDataHandler, _resetClustersDataCache };
