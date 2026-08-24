// srv/jobs/freshness-corpus-embedding-job.js
//
// Task 3 (spec 2026-08-22): backfill job for ApiDocs/Samples vector columns.
//
// Mirrors the raw-SQL vector-write convention from concept-embedding-backfill.js
// (SET EMBEDDING = ?, EMBEDDINGVEC = TO_REAL_VECTOR(?)).
// SQLite unit tests can't run TO_REAL_VECTOR; the isHana() guard selects the
// correct write path. embeddingVec is intentionally skipped on SQLite
// (not expressible; the HANA COSINE_SIMILARITY path is the only real consumer).

import cds from '@sap/cds';
import { embed } from '../lib/embedding-client.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';

const LOG = cds.log('freshness-corpus-embedding');
const BATCH = 100;
const DIMS = 1536;
const BYTES_PER_FLOAT = 4;

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana';
}

function encodeBlob(vec) {
  const buf = Buffer.alloc(vec.length * BYTES_PER_FLOAT);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * BYTES_PER_FLOAT);
  return buf;
}

async function embedEntity(db, entity, tableName, model) {
  // Select only rows whose embedding BLOB is null (SQLite-safe CDS QL).
  const rows = await SELECT.from(entity).columns('ID', 'title', 'description').where('embedding is null');
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const texts = chunk.map(r => `${r.title || ''}\n${r.description || ''}`.trim());
    const vectors = await embed(texts, model);
    for (let j = 0; j < chunk.length; j++) {
      const vec = vectors[j];
      if (!vec || vec.length !== DIMS) {
        LOG.warn(`[freshness-corpus] skipped ${chunk[j].ID}: bad vector length ${vec?.length ?? 'null'}`);
        continue;
      }
      const blob = encodeBlob(vec);
      if (isHana(db)) {
        // raw SQL: TO_REAL_VECTOR is not expressible in CDS QL (sanctioned exception —
        // mirrors concept-embedding-backfill.js:133).
        const arr = '[' + Array.from(vec, x => x.toFixed(6)).join(',') + ']';
        await db.run(
          `UPDATE "${tableName}" SET "EMBEDDING" = ?, "EMBEDDINGVEC" = TO_REAL_VECTOR(?) WHERE "ID" = ?`,
          [blob, arr, chunk[j].ID],
        );
      } else {
        // SQLite: write the BLOB only; no REAL_VECTOR support.
        await UPDATE(entity).set({ embedding: blob }).where({ ID: chunk[j].ID });
      }
      n++;
    }
  }
  return n;
}

/**
 * Backfill embedding columns for ApiDocs and Samples rows that lack them.
 *
 * @param {string} _logId   - caller-supplied correlation id (for future audit log)
 * @param {object} [_opts]  - reserved for future options
 * @returns {Promise<{apiDocs:number, samples:number}>}
 */
export async function runFreshnessCorpusEmbedding(_logId, _opts) {
  const db = await cds.connect.to('db');
  const { model } = await resolveEmbeddingSettings();
  const { ApiDocs, Samples } = cds.entities('com.sap.developers.ims.external');
  try {
    const apiDocs = await embedEntity(db, ApiDocs, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_APIDOCS', model);
    const samples = await embedEntity(db, Samples, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_SAMPLES', model);
    LOG.info(`[freshness-corpus] embedded apiDocs=${apiDocs} samples=${samples}`);
    return { apiDocs, samples };
  } catch (err) {
    LOG.error('[freshness-corpus] embedding failed', err);
    throw err;
  }
}
