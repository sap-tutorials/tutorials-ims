// srv/lib/freshness-grounding.js
// Task 4 (spec 2026-08-22): Grounding helper for the tutorial freshness detector.
//
// Given a code block, embeds it and cosine-searches ApiDocs/Samples embeddings
// for the nearest chunks. Mirrors srv/lib/kg/concept-embedding-query.js.
//
// Two paths gated by isHana():
//   - HANA: raw SQL using COSINE_SIMILARITY + TO_REAL_VECTOR (sanctioned BLOB exception).
//     Never SELECTs the EMBEDDING BLOB alongside metadata to avoid LOB-locator expiry.
//   - SQLite (unit tests): fetch all rows with a non-null embedding BLOB, decode
//     Float32 in JS, rank locally.

import cds from '@sap/cds';
import { embed } from './embedding-client.js';

function isHana(db) { return (db.kind || db.options?.kind) === 'hana'; }
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function decode(buf) {
  if (!buf) return null;
  // @cap-js/sqlite stores Buffer values as base64 strings (SQLiteService.js:108/219).
  // Raw SQL retrieval therefore returns a base64 string, not a Buffer. Mirror the
  // handling in concept-embedding-query.js#decodeEmbedding to cover all wire formats.
  let b;
  if (Buffer.isBuffer(buf)) b = buf;
  else if (typeof buf === 'string') b = Buffer.from(buf, 'base64');
  else if (buf instanceof Uint8Array) b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  else b = Buffer.from(buf);
  const dims = Math.floor(b.byteLength / 4);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

async function searchEntity(db, tableName, source, qVec, limit, minScore) {
  if (isHana(db)) {
    const arr = '[' + Array.from(qVec, x => x.toFixed(6)).join(',') + ']';
    // raw SQL: COSINE_SIMILARITY + BLOB (sanctioned exception). Do NOT select EMBEDDING here.
    const rows = await db.run(
      `SELECT TOP ${limit} "ID", "TITLE", "URL",
              COSINE_SIMILARITY("EMBEDDINGVEC", TO_REAL_VECTOR(?)) AS "SCORE"
         FROM "${tableName}" WHERE "EMBEDDINGVEC" IS NOT NULL ORDER BY "SCORE" DESC`, [arr]);
    return rows.filter(r => r.SCORE >= minScore)
               .map(r => ({ source, id: r.ID, title: r.TITLE, url: r.URL, score: r.SCORE }));
  }
  // SQLite unit path: raw db.run() so LargeBinary comes back as a Buffer,
  // not a Readable stream (CDS QL wraps BLOB in a stream; raw SQL does not).
  // Table name convention: dotted namespace → underscored, entity appended.
  const sqliteTable = source === 'apidoc'
    ? 'com_sap_developers_ims_external_ApiDocs'
    : 'com_sap_developers_ims_external_Samples';
  const rows = await db.run(`SELECT ID, title, url, embedding FROM "${sqliteTable}" WHERE embedding IS NOT NULL`);
  return rows.map(r => ({ source, id: r.ID, title: r.title, url: r.url, score: cosine(qVec, decode(r.embedding)) }))
             .filter(r => r.score >= minScore)
             .sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Embed a code block and return the nearest ApiDocs/Samples chunks by cosine
 * similarity.
 *
 * @param {object} args
 * @param {object} args.db - CDS db service instance.
 * @param {string} args.code - Code block text to ground.
 * @param {number} [args.limit=4] - Max combined results to return.
 * @param {number} [args.minScore=0.25] - Minimum cosine score threshold.
 * @returns {Promise<Array<{source:'apidoc'|'sample', id:string, title:string, url:string, score:number}>>}
 *   Results sorted by score descending.
 */
export async function groundCodeBlock({ db, code, limit = 4, minScore = 0.25 }) {
  if (!code || !code.trim()) return [];
  const [qVec] = await embed([code]);
  if (!qVec) return [];
  const [a, s] = await Promise.all([
    searchEntity(db, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_APIDOCS', 'apidoc', qVec, limit, minScore),
    searchEntity(db, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_SAMPLES', 'sample', qVec, limit, minScore),
  ]);
  return [...a, ...s].sort((x, y) => y.score - x.score).slice(0, limit);
}
