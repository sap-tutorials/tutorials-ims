// srv/routes/kg-stats.js
// Public unauthenticated endpoint for the knowledge-graph stats counter
// rendered in the hero of /explore/about/. Spec: docs/superpowers/specs/2026-06-29-751-kg-overview-page-design.md.

import cds from '@sap/cds';

const log = cds.log('kg-stats');

const TTL_MS = 60_000;
const MAX_AGE_S = TTL_MS / 1000;

// Cache is anchored on the cds singleton rather than module-local state because
// cds.test('serve') boots the server in a CJS module realm (via @sap/cds's
// cds.server() bootstrap, which uses require()), while this file's test imports
// it as ESM. Node's CJS and ESM module caches are separate registries, so
// module-local `let current` would be different variables in the two contexts —
// `_resetKgStatsCache()` from the test side would silently no-op. The `cds`
// object is the one thing resolved at the @sap/cds package boundary and shared
// across both registries.
function getCache() {
  if (!cds._kgStatsCache) {
    cds._kgStatsCache = { current: null, lastGood: null };
  }
  return cds._kgStatsCache;
}

async function computePayload() {
  const db = await cds.connect.to('db');
  const { Tutorials, Concepts, ConceptEdges, Missions, Groups } =
    cds.entities('com.sap.developers.ims');

  // Four COUNT queries + one MAX. Run in parallel — they're independent.
  // Concepts: status='ACTIVE' AND publishedAt IS NOT NULL is the documented
  // public-published gate (db/knowledge-graph.cds:36-39).
  // ConceptEdges: only ACTIVE edges count; VETOED edges are admin-suppressed.
  // lastExtractedAt comes from ConceptEdges.extractedAt — Concepts itself
  // has firstSeenAt/lastSeenAt/publishedAt but NOT extractedAt.
  const [tutCount, conCount, edgeCount, misCount, grpCount, maxExtracted] =
    await Promise.all([
      db.run(SELECT.from(Tutorials).columns('count(*) as n')),
      db.run(
        SELECT.from(Concepts)
          .where({ status: 'ACTIVE', publishedAt: { '!=': null } })
          .columns('count(*) as n')
      ),
      db.run(
        SELECT.from(ConceptEdges)
          .where({ status: 'ACTIVE' })
          .columns('count(*) as n')
      ),
      db.run(SELECT.from(Missions).columns('count(*) as n')),
      db.run(SELECT.from(Groups).columns('count(*) as n')),
      db.run(
        SELECT.from(ConceptEdges)
          .where({ status: 'ACTIVE' })
          .columns('max(extractedAt) as t')
      ),
    ]);

  return {
    tutorials: tutCount[0]?.n ?? 0,
    concepts: conCount[0]?.n ?? 0,
    relationships: edgeCount[0]?.n ?? 0,
    missionsAndGroups: (misCount[0]?.n ?? 0) + (grpCount[0]?.n ?? 0),
    lastExtractedAt: maxExtracted[0]?.t ?? null,
    generatedAt: new Date().toISOString(),
  };
}

export async function kgStatsHandler(req, res) {
  const cache = getCache();
  const now = Date.now();
  if (cache.current && cache.current.expiresAt > now) {
    res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_S}, stale-while-revalidate=300`);
    res.json(cache.current.payload);
    return;
  }

  try {
    const payload = await computePayload();
    cache.current = { payload, expiresAt: now + TTL_MS };
    cache.lastGood = payload;
    res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_S}, stale-while-revalidate=300`);
    res.json(payload);
  } catch (err) {
    log.error('kg-stats compute failed', err);
    if (cache.lastGood) {
      // Graceful degradation: return previous good payload with same caching.
      res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_S}, stale-while-revalidate=300`);
      res.json(cache.lastGood);
      return;
    }
    res.status(503).json({ error: 'kg_stats_unavailable' });
  }
}

// Exported for tests only — lets the test reset state between cases if needed.
export function _resetKgStatsCache() {
  delete cds._kgStatsCache;
}
