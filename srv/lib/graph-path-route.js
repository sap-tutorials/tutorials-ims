// srv/lib/graph-path-route.js
//
// Express handler for GET /graph/path?from=<slug>&to=<slug>.
// Returns the ordered list of tutorial steps connecting two tutorials in the
// knowledge graph. Public, unauthenticated; consumed by the /explore/
// Sigma.js overlay (see app/explore/src/api/path.ts).
//
// Path-finding logic lives in srv/lib/kg-path.js (shared with the Joule
// chat tool srv/lib/kg/joule-tool-find-path.js). This module is the
// thin HTTP shim: validate slugs, dispatch findPath(), shape the response.
//
// Issue #446, Phase 3 Track 3-B PR 5/6.

import cds from '@sap/cds';
import { findPath } from './kg-path.js';

const log = cds.log('graph-path-route');

// Lockstep with srv/lib/kg/joule-tool-find-path.js SLUG_RE. The KG procedure
// validates p1/p2 against its own LIKE_REGEXPR allow-list as well, but
// rejecting at the HTTP layer means malformed input never reaches HANA.
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

export async function graphPathHandler(req, res) {
  try {
    const from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
    const to = typeof req.query?.to === 'string' ? req.query.to.trim() : '';

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to query params required' });
    }
    if (!SLUG_RE.test(from) || !SLUG_RE.test(to)) {
      return res.status(400).json({ error: 'invalid slug format' });
    }
    if (from === to) {
      return res.status(400).json({ error: 'from and to must differ' });
    }

    const db = await cds.connect.to('db');
    const steps = await findPath({ db, fromSlug: from, toSlug: to });

    if (!steps.length) {
      return res.status(404).json({ error: 'No path found', from, to });
    }

    // 60s cache: path queries are deterministic for the lifetime of a
    // graph version (rebuilt by the projection cron); 60s is short
    // enough to pick up new projections without hammering HANA.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ from, to, steps });
  } catch (err) {
    log.error('failed to find path', err);
    return res.status(500).json({ error: 'Path query failed' });
  }
}
