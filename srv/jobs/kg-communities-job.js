// KG community detection nightly job (#917).
//
// Calls HANA GraphScript KG_LOUVAIN_GRAPH, TRUNCATEs KgCommunity, and
// batch-INSERTs the memberships inside one db.tx. Fail-open: errors
// propagate up so the scheduler chassis writes PipelineLog FAILED, but
// no request-time reader breaks because loading is decoupled at Task 6.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const LOG = cds.log('kg-communities');

const KG_COMMUNITY_TABLE = '"COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"';
const INSERT_BATCH_SIZE = 500;

export async function runKgCommunities() {
  const started = Date.now();
  try {
    const db = await cds.connect.to('db');
    const rows = await db.run('CALL "KG_LOUVAIN_GRAPH"()');

    const byCommunity = new Map();
    for (const r of rows) {
      const cid = Number(r.COMMUNITY_ID);
      byCommunity.set(cid, (byCommunity.get(cid) || 0) + 1);
    }
    const maxSize = byCommunity.size ? Math.max(...byCommunity.values()) : 0;

    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${KG_COMMUNITY_TABLE}`);
      const now = new Date().toISOString();
      const insertSql = `INSERT INTO ${KG_COMMUNITY_TABLE}
        ("communityId","vertexKey","vertexType","slug","detectedAt")
        VALUES (?, ?, ?, ?, ?)`;
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + INSERT_BATCH_SIZE).map((r) => [
          Number(r.COMMUNITY_ID),
          String(r.VERTEX_KEY),
          String(r.VERTEX_TYPE),
          r.SLUG == null ? null : String(r.SLUG),
          now,
        ]);
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
