// KG community detection nightly job (#917).
//
// Calls HANA GraphScript KG_LOUVAIN_GRAPH, TRUNCATEs KgCommunity, and
// batch-INSERTs the memberships inside one db.tx. Fail-open: errors
// propagate up so the scheduler chassis writes PipelineLog FAILED, but
// no request-time reader breaks because loading is decoupled at Task 6.
//
// #985: every inserted row also carries a communityFingerprint —
// SHA-256 hex over the sorted tutorial-typed member slug set for that
// row's communityId. Denormalized (same value on every row of a given
// community) so KgCommunitySummaryV can LEFT JOIN Missions on it and
// materialize `alreadyPromoted` at the DB layer (#986). Fingerprints
// are computed once per pass here using the shared helper at
// srv/lib/kg-community-fingerprint.js — the same helper the
// promoteCommunityToMission handler uses at write time.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';
import { computeKgCommunityFingerprint } from '../lib/kg-community-fingerprint.js';

const LOG = cds.log('kg-communities');

const KG_COMMUNITY_TABLE = '"COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"';
const INSERT_BATCH_SIZE = 500;

// DO-block wrapper converts KG_LOUVAIN_GRAPH's OUT TABLE(...) param to a
// SELECT result-set that db.run() can read. @cap-js/hana does NOT bind
// OUT params via db.run('CALL <proc>()'), so the naive CALL form yields
// zero rows on real HANA — see srv/lib/kg-path-v2-client.js:28 and
// srv/lib/kg-sparql-client.js:73 for the parallel workaround on the
// KG_PATH_V2 / SPARQL procedures. Column names in the local TABLE
// declaration are echoed as the DO-block SELECT's column names, which
// @cap-js/hana uppercases when returning rows — the read below matches
// that (r.COMMUNITY_ID, r.VERTEX_KEY, …).
const DO_KG_LOUVAIN = `DO BEGIN
  DECLARE members TABLE (
    community_id BIGINT,
    vertex_key   NVARCHAR(280),
    vertex_type  NVARCHAR(16),
    slug         NVARCHAR(255)
  );
  CALL KG_LOUVAIN_GRAPH(:members);
  SELECT * FROM :members;
END`;

export async function runKgCommunities() {
  const started = Date.now();
  try {
    const db = await cds.connect.to('db');
    const raw = await db.run(DO_KG_LOUVAIN);

    // @cap-js/hana wraps DO-block results as {changes: [{}, [rows]]} in
    // production, but tests / other drivers return a plain array. Match
    // both shapes defensively — mirrors kg-path-v2-client.js:84-86.
    const rows = Array.isArray(raw)
      ? (Array.isArray(raw[0]) ? raw[0] : raw)
      : (raw?.changes?.[1] ?? []);

    // First pass — group tutorial slugs by communityId so we can hash
    // each community's tutorial cluster once. Communities with zero
    // tutorial members get fingerprint=null; the promote path only
    // accepts communities with at least one tutorial member.
    const tutorialSlugsByCommunity = new Map();
    const byCommunity = new Map();
    for (const r of rows) {
      const cid = Number(r.COMMUNITY_ID);
      byCommunity.set(cid, (byCommunity.get(cid) || 0) + 1);
      if (r.VERTEX_TYPE === 'tutorial' && r.SLUG != null) {
        if (!tutorialSlugsByCommunity.has(cid)) {
          tutorialSlugsByCommunity.set(cid, []);
        }
        tutorialSlugsByCommunity.get(cid).push(String(r.SLUG));
      }
    }
    const fingerprintByCommunity = new Map();
    for (const [cid, slugs] of tutorialSlugsByCommunity) {
      if (slugs.length === 0) continue;
      fingerprintByCommunity.set(cid, computeKgCommunityFingerprint(slugs));
    }
    const maxSize = byCommunity.size ? Math.max(...byCommunity.values()) : 0;

    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${KG_COMMUNITY_TABLE}`);
      const now = new Date().toISOString();
      // Identifiers must be quoted-uppercase: the .hdbtable declares them unquoted,
      // so HANA stores them upper-case in the catalog (COMMUNITYID, not communityId).
      // Same pattern as srv/lib/embedding-pipeline.js:119. Mixed-case quoted names
      // fail with "invalid column name" because quoted identifiers are case-sensitive.
      const insertSql = `INSERT INTO ${KG_COMMUNITY_TABLE}
        ("COMMUNITYID","VERTEXKEY","VERTEXTYPE","SLUG","DETECTEDAT","COMMUNITYFINGERPRINT")
        VALUES (?, ?, ?, ?, ?, ?)`;
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + INSERT_BATCH_SIZE).map((r) => {
          const cid = Number(r.COMMUNITY_ID);
          return [
            cid,
            String(r.VERTEX_KEY),
            String(r.VERTEX_TYPE),
            r.SLUG == null ? null : String(r.SLUG),
            now,
            fingerprintByCommunity.get(cid) ?? null,
          ];
        });
        await tx.run(insertSql, batch);
      }
    });

    const durationMs = Date.now() - started;
    metrics.observe('kg_communities_duration_ms', durationMs);
    metrics.gauge('kg_communities_count', byCommunity.size);
    metrics.gauge('kg_communities_max_size', maxSize);
    LOG.info(`[kg-communities] wrote ${rows.length} memberships across ${byCommunity.size} communities (max size ${maxSize}) in ${durationMs}ms`);

    return { rowCount: rows.length, communityCount: byCommunity.size, maxSize, durationMs };
  } catch (err) {
    metrics.counter('kg_communities_failures');
    LOG.error('[kg-communities] failed', err);
    throw err;
  }
}

export default { runKgCommunities };
