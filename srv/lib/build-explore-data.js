// srv/lib/build-explore-data.js
//
// Express middleware backing GET /graph/explore-data.
// Pattern matches srv/lib/build-concepts.js. Unauthenticated by design;
// consumed by the /explore/ Hugo page for first-paint hydration and by
// the client-side Sigma.js graph when filters change.
//
// 5-min in-process LRU cache: the underlying SPARQL bulk fetch is ~hundreds
// of thousands of triples; cache amortises it across page loads. Hit/miss
// is reflected in the X-Cache response header for downstream debugging.
//
// k-anonymity is enforced at projection time (srv/lib/kg-projection.js
// buildCoCompletionTriples) — this handler does not re-check.
//
// Issue #446, Phase 3 Track 3-B PR 4/9.

import cds from '@sap/cds';
import { buildExplorePayload } from './kg-explore-data.js';

const log = cds.log('build-explore-data');

const TTL_MS = 5 * 60 * 1000;

let cached = null;
let cachedAt = 0;

export async function exploreDataHandler(req, res) {
  try {
    const now = Date.now();
    if (cached && now - cachedAt < TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
    const db = await cds.connect.to('db');
    const payload = await buildExplorePayload(db);
    if (payload.droppedBindings > 0) {
      // Non-zero means at least one SPARQL row had a non-empty IRI that
      // didn't match any prefix in IRI_TYPE_MAP — usually schema drift
      // (a new entity type added to kg-projection.js but not registered
      // in kg-explore-data.js). Don't strip the field from the wire
      // response; it's a small int and useful for client-side observability.
      log.warn(
        `dropped ${payload.droppedBindings} unparseable SPARQL bindings — investigate schema drift`
      );
    }
    cached = payload;
    cachedAt = now;
    res.setHeader('X-Cache', 'MISS');
    return res.json(payload);
  } catch (err) {
    log.error('failed to build /graph/explore-data payload', err);
    return res.status(500).json({ error: 'Explore-data query failed' });
  }
}

/**
 * Test-only: clear the cache between requests in unit tests / between
 * runs in hybrid tests. Not part of the public API.
 */
export function _resetExploreDataCache() {
  cached = null;
  cachedAt = 0;
}
