// srv/lib/kg-concept-loader.js
// Shared helper: load every ACTIVE concept with embedding bytes decoded into
// a Float32Array, plus the metadata findNearDuplicates needs (extractionCount,
// firstSeenAt) for deterministic canonical-picking.
//
// Two call sites consume this:
//   - srv/jobs/consolidate-concepts-job.js  (weekly cron, applies merges)
//   - srv/knowledge-graph-service.js previewMerges (admin dry-run)
//
// Why raw SQL on HANA: HANA returns LargeBinary columns as a Readable stream
// backed by a LOB locator that expires before consumption when SELECTed
// alongside scalar columns in CDS QL. The raw-SQL escape hatch mirrors the
// established pattern in srv/lib/embedding-query.js +
// srv/jobs/extract-concepts-job.js. SQLite (unit-test path) is fine with CDS QL.
//
// Plan ref: docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md
//           (PR 6 / Task 6.1 — extracted from consolidate-concepts-job.js)

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

/**
 * Detect whether the bound DB is HANA (vs SQLite, used in unit tests).
 * Mirrors the convention used in srv/lib/embedding-query.js +
 * srv/jobs/extract-concepts-job.js.
 */
function isHana(db) {
  return db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
}

/**
 * Convert a HANA LOB Buffer (or SQLite BLOB Buffer) into a Float32Array view.
 *
 * Embeddings are stored as packed little-endian Float32 byte sequences (see
 * how PR 3's extract-concepts-job + srv/lib/embedding-query.js construct
 * them: `Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)`). The
 * inverse here MUST stay byte-for-byte symmetric.
 *
 * Returns null if the buffer length is not a multiple of 4 — the caller logs
 * a warning and skips the row rather than emitting garbage similarity scores.
 *
 * @param {Buffer|Uint8Array|null} buf
 * @returns {Float32Array|null}
 */
export function bufferToFloat32Array(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/**
 * Load every ACTIVE concept with the metadata + embedding the consolidator
 * (and the previewMerges admin action) need: slug, name, extractionCount,
 * firstSeenAt, embedding (decoded to Float32Array as `embeddingVec`).
 *
 * Concepts whose embedding is missing or has a non-multiple-of-4 byte length
 * are skipped with a warning — they would produce garbage similarity scores.
 *
 * @param {object} db    bound DB service from cds.connect.to('db')
 * @param {object} log   cds.log instance (callsite-specific tag)
 * @returns {Promise<Array<{ID, slug, name, extractionCount, firstSeenAt, embeddingVec}>>}
 */
export async function loadConceptsWithEmbeddings(db, log) {
  const rows = isHana(db)
    ? await db.run(
        `SELECT "ID", "SLUG", "NAME", "EXTRACTIONCOUNT", "FIRSTSEENAT", "EMBEDDING"
         FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE "STATUS" = 'ACTIVE'`,
      )
    : await (async () => {
        const { Concepts } = cds.entities(NAMESPACE);
        return SELECT.from(Concepts)
          .columns('ID', 'slug', 'name', 'extractionCount', 'firstSeenAt', 'embedding')
          .where({ status: 'ACTIVE' });
      })();

  const out = [];
  for (const r of rows) {
    const ID = r.ID ?? r.id;
    const slug = r.SLUG ?? r.slug;
    const name = r.NAME ?? r.name;
    const extractionCount = r.EXTRACTIONCOUNT ?? r.extractionCount ?? 0;
    const firstSeenAt = r.FIRSTSEENAT ?? r.firstSeenAt;
    const embedding = r.EMBEDDING ?? r.embedding;
    if (!ID) continue;

    const embeddingVec = bufferToFloat32Array(embedding);
    if (!embeddingVec) {
      log?.warn?.(
        `kg-concept-loader: concept ${ID} (${slug}) has missing/malformed embedding — skipping`,
      );
      continue;
    }
    out.push({ ID, slug, name, extractionCount, firstSeenAt, embeddingVec });
  }
  return out;
}
