// srv/lib/step-vectors.js
//
// HANA-aware tutorial step-embedding loader. Pulled out of
// srv/handlers/recommendations.js so both the recommend pipeline and the
// PR 2 branch loaders can share one implementation.
//
// HANA-only path uses raw SQL because mixing BLOB columns with metadata
// in CDS QL triggers LOB-locator expiry (see CLAUDE.md gotcha).
//
// Two public loaders:
//   - `loadStepVectors(id)` — single-tutorial fetch, one round-trip.
//   - `loadStepVectorsBulk(ids)` — multi-tutorial fetch, one round-trip
//     regardless of `ids.length`. Prefer this in any loop over tutorials
//     (issue #294 collapsed several N+1 sequences).

import cds from '@sap/cds';

/**
 * Load all step embeddings for one tutorial.
 *
 * Returns a plain `Float32Array[]` (order matches DB return order, which is
 * not stepNumber-sorted — callers that need step ordering should use
 * `loadStepVectorsBulk` or join with Steps themselves).
 *
 * Rows whose embedding BLOB is malformed (byteLength not divisible by 4)
 * are silently dropped via `.filter(Boolean)`; corrupted embeddings should
 * never crash a recommendation call.
 *
 * @param {string|number} tutorialId
 * @returns {Promise<Float32Array[]>}
 */
export async function loadStepVectors(tutorialId) {
  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const sql = `
      SELECT "EMBEDDING"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
      WHERE "TUTORIAL_ID" = ?`;
    const rows = await db.run(sql, [tutorialId]);
    return rows.map(r => bufToFloat32(r.EMBEDDING ?? r.embedding)).filter(Boolean);
  }
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialEmbedding).columns('embedding').where({ tutorial_ID: tutorialId });
  return rows.map(r => bufToFloat32(r.embedding)).filter(Boolean);
}

/**
 * Bulk variant of loadStepVectors. Returns a Map<tutorialId, Float32Array[]>
 * with one entry per requested ID (empty array if a tutorial has no embeddings).
 *
 * One round-trip on HANA via WHERE TUTORIAL_ID IN (...). Used by branch
 * loaders to fold the prior N+1 sequential loop into a single query
 * (issue #294).
 */
export async function loadStepVectorsBulk(tutorialIds) {
  const out = new Map();
  if (!tutorialIds || tutorialIds.length === 0) return out;
  // Dedup while preserving order; seed empty arrays so callers get a complete
  // map even when a tutorial has zero embedding rows.
  const ids = [];
  for (const id of tutorialIds) {
    if (id == null || out.has(id)) continue;
    ids.push(id);
    out.set(id, []);
  }
  if (ids.length === 0) return out;

  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (isHana) {
    // HANA accepts a positional placeholder per id; cds.db.run does NOT expand
    // a JS array passed as a single bind, so we expand here.
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT "TUTORIAL_ID", "EMBEDDING"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
      WHERE "TUTORIAL_ID" IN (${placeholders})`;
    const rows = await db.run(sql, ids);
    for (const r of rows) {
      const tid = r.TUTORIAL_ID ?? r.tutorial_ID;
      const v = bufToFloat32(r.EMBEDDING ?? r.embedding);
      if (!v) continue;
      const bucket = out.get(tid);
      if (bucket) bucket.push(v);
    }
    return out;
  }

  // SQLite test path: CDS QL handles `in:` array expansion correctly.
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialEmbedding)
    .columns('tutorial_ID', 'embedding')
    .where({ tutorial_ID: { in: ids } });
  for (const r of rows) {
    const v = bufToFloat32(r.embedding);
    if (!v) continue;
    const bucket = out.get(r.tutorial_ID);
    if (bucket) bucket.push(v);
  }
  return out;
}

/**
 * Decode a stored embedding into a `Float32Array`, or `null` if the payload
 * is empty/corrupt. Polymorphic input:
 *   - `Buffer` / `Uint8Array` — production HANA path (raw BLOB bytes).
 *   - `string` — SQLite path via CDS QL. The driver JSON-stringifies BLOBs
 *     as `'{"type":"Buffer","data":[…]}'` when they're read back through
 *     the SQLite adapter; we parse it here so tests match production shape.
 *   - falsy / any other type — returns `null`.
 *
 * Returns `null` when `byteLength % 4 !== 0` (Float32 requires a multiple
 * of 4). Callers use `.filter(Boolean)` to drop malformed rows.
 *
 * @param {Buffer|Uint8Array|string|null|undefined} blob
 * @returns {Float32Array | null}
 */
export function bufToFloat32(blob) {
  if (!blob) return null;
  // SQLite stores Vector(N) as a JSON-stringified Buffer literal:
  //   '{"type":"Buffer","data":[0,0,128,63,...]}'
  // We only see this in unit tests; production (HANA) returns a raw Buffer.
  if (typeof blob === 'string') {
    if (blob.length === 0) return null;
    try {
      const parsed = JSON.parse(blob);
      if (parsed && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
        const buf = Buffer.from(parsed.data);
        // Float32 = 4 bytes; anything else is corruption, skip silently.
        if (buf.byteLength % 4 !== 0) return null;
        return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      }
    } catch { /* fall through */ }
    return null;
  }
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
