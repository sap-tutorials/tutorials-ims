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

async function embedEntity(db, entity, tableName, model, textColumn = 'description') {
  // Select only rows whose embedding BLOB is null (SQLite-safe CDS QL).
  // `textColumn` is the source-owned NCLOB that carries the body text — most
  // corpora call it `description`; TechEdSessions call it `abstract` (#2312).
  const rows = await SELECT.from(entity).columns('ID', 'title', textColumn).where('embedding is null');
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const texts = chunk.map(r => `${r.title || ''}\n${r[textColumn] || ''}`.trim());
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
 * Backfill embedding columns for ApiDocs, Samples, DevtoberfestSessions, and
 * TechEdSessions rows that lack them.
 *
 * @param {string} _logId   - caller-supplied correlation id (for future audit log)
 * @param {object} [_opts]  - reserved for future options
 * @returns {Promise<{apiDocs:number, samples:number, devtoberfestSessions:number, techedSessions:number}>}
 */
export async function runFreshnessCorpusEmbedding(_logId, _opts) {
  const db = await cds.connect.to('db');
  const { model } = await resolveEmbeddingSettings();
  const { ApiDocs, Samples, DevtoberfestSessions, TechEdSessions } = cds.entities('com.sap.developers.ims.external');
  try {
    const apiDocs = await embedEntity(db, ApiDocs, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_APIDOCS', model);
    const samples = await embedEntity(db, Samples, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_SAMPLES', model);
    // #2311: embed Devtoberfest sessions for the semantic-search 'external'
    // corpus. embedEntity is generic over title+description (session abstract).
    const devtoberfestSessions = await embedEntity(
      db, DevtoberfestSessions, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_DEVTOBERFESTSESSIONS', model,
    );
    // #2312 (Unit 5): embed TechEd sessions for the 'teched'/'external'/'all'
    // corpora. Fault-isolated: TechEdSessions is a newer table that may be
    // absent on an env without the migration, so a failure here must NOT abort
    // the whole job or mask the apiDocs/samples/devtoberfest counts already
    // computed above. Log and continue with 0. The body text column is
    // `abstract`, not `description`.
    let techedSessions = 0;
    try {
      techedSessions = await embedEntity(
        db, TechEdSessions, 'COM_SAP_DEVELOPERS_IMS_EXTERNAL_TECHEDSESSIONS', model, 'abstract',
      );
    } catch (techedErr) {
      LOG.warn('[freshness-corpus] TechEdSessions embedding skipped:', techedErr.message);
    }
    LOG.info(`[freshness-corpus] embedded apiDocs=${apiDocs} samples=${samples} devtoberfestSessions=${devtoberfestSessions} techedSessions=${techedSessions}`);
    return { apiDocs, samples, devtoberfestSessions, techedSessions };
  } catch (err) {
    LOG.error('[freshness-corpus] embedding failed', err);
    throw err;
  }
}
