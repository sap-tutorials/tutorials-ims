// srv/lib/kg/on-demand-cosine-rank.js
//
// Rank ACTIVE tutorials by MAX cosine similarity between a query vector
// and any TutorialEmbedding step of that tutorial.
//
// #1113: HANA branch now uses HANA's native COSINE_SIMILARITY over the
// existing REAL_VECTOR(1536) column — one SQL round-trip for ranking,
// one small IN-list for metadata hydration. No LOB locator issue because
// TutorialEmbedding.EMBEDDING is REAL_VECTOR, not a BLOB.
//
// SQLite branch unchanged — small dev dataset; JS-side cosine over BLOBs.
//
// Result: top-K { tutorialId, slug, title, score } sorted by score DESC.
//
// Spec: docs/superpowers/specs/2026-07-09-1113-hana-cosine-similarity-design.md
// Issue: #1113

import { fetchTutorialsByIds } from './_search-fetches.js';

const DIMS = 1536;
const BYTES_PER_FLOAT = 4;

function decodeEmbedding(buf) {
  if (!buf) return null;
  let bytes;
  if (Buffer.isBuffer(buf)) {
    bytes = buf;
  } else if (typeof buf === 'string') {
    // Two wire formats from SQLite:
    //   1. Base64 string (when stored via db.run raw SQL INSERT)
    //   2. JSON {"type":"Buffer","data":[...]} (when stored via CDS QL INSERT)
    if (buf.startsWith('{')) {
      try {
        const parsed = JSON.parse(buf);
        if (parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
          bytes = Buffer.from(parsed.data);
        } else {
          bytes = Buffer.from(buf, 'base64');
        }
      } catch {
        bytes = Buffer.from(buf, 'base64');
      }
    } else {
      bytes = Buffer.from(buf, 'base64');
    }
  } else if (buf instanceof Uint8Array) {
    bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    bytes = Buffer.from(buf);
  }
  if (bytes.length !== DIMS * BYTES_PER_FLOAT) return null;
  const out = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) out[i] = bytes.readFloatLE(i * BYTES_PER_FLOAT);
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIMS; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana' ||
    db?.constructor?.name === 'HANAService';
}

/**
 * Rank ACTIVE tutorials by MAX cosine similarity between queryVector and
 * any TutorialEmbedding step.
 *
 * #1113: HANA branch now uses the vector engine (COSINE_SIMILARITY over
 * REAL_VECTOR(1536) — the column type TutorialEmbedding already had). One
 * SQL round-trip for the ranking, one small IN-list for metadata hydration.
 * SQLite branch unchanged — small dev dataset, JS-side cosine is fine.
 *
 * @param {object} opts
 * @param {object} opts.db          cds.connect.to('db') handle
 * @param {Float32Array|number[]} opts.queryVector  1536-dim query embedding
 * @param {number} opts.limit       Top-K to return (default 5)
 * @returns {Promise<Array<{ tutorialId: string, slug: string, title: string, score: number }>>}
 */
export async function rankTutorialsByQueryVector({ db, queryVector, limit = 5 }) {
  const q = queryVector instanceof Float32Array
    ? queryVector
    : Float32Array.from(queryVector);

  if (isHana(db)) {
    // Serialize as HANA REAL_VECTOR string literal — same convention as
    // concept-embedding-query.js and the backfill job. See #1113 spec.
    const vecStr = '[' + Array.from(q, x => x.toFixed(6)).join(',') + ']';

    // Phase 1: HANA does the cosine + top-K in one round-trip.
    const ranked = await db.run(
      `SELECT TOP ? TUTORIAL_ID as tutorial_id,
              MAX(COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?))) AS score
       FROM COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING
       WHERE EMBEDDING IS NOT NULL
       GROUP BY TUTORIAL_ID
       ORDER BY score DESC`,
      [limit, vecStr]
    ) || [];
    if (ranked.length === 0) return [];

    // Phase 2: hydrate slug/title for the winners. Delegates to _search-fetches.
    const ids = ranked.map(r => r.tutorial_id);
    const metaRows = await fetchTutorialsByIds(db, ids);
    const metaById = new Map(metaRows.map(m => [m.id, m]));

    return ranked
      .map(r => {
        const meta = metaById.get(r.tutorial_id);
        return meta
          ? { tutorialId: r.tutorial_id, slug: meta.slug, title: meta.title, score: r.score }
          : null;
      })
      .filter(Boolean);
  }

  // SQLite path — unchanged. Small dev dataset; JS-side cosine over the full
  // TutorialEmbedding table + ACTIVE Tutorials join. See git history for
  // the pre-#1113 implementation.
  const rows = await db.run(
    `SELECT ID, slug, title FROM com_sap_developers_ims_Tutorials WHERE status = 'ACTIVE'`
  );
  if (!rows || rows.length === 0) return [];
  const metaById = new Map(rows.map(t => [t.ID, t]));
  const ids = [...metaById.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const embRows = await db.run(
    `SELECT tutorial_ID, stepNumber, embedding
     FROM com_sap_developers_ims_TutorialEmbedding
     WHERE tutorial_ID IN (${placeholders})`,
    ids
  );

  const bestByTutorial = new Map();
  for (const r of embRows) {
    const tid = r.tutorial_ID ?? r.TUTORIAL_ID;
    const emb = decodeEmbedding(r.embedding ?? r.EMBEDDING);
    if (!emb) continue;
    const c = cosine(q, emb);
    const prev = bestByTutorial.get(tid) ?? -Infinity;
    if (c > prev) bestByTutorial.set(tid, c);
  }

  return [...bestByTutorial.entries()]
    .map(([tid, score]) => {
      const meta = metaById.get(tid);
      return meta ? { tutorialId: tid, slug: meta.slug, title: meta.title, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
