// srv/jobs/concept-embedding-backfill.js
//
// One-shot backfill + reconciliation for Concepts.embedding.
//
// Distinct from the TutorialEmbedding reconciliation job — Concepts.embedding
// is a plain LargeBinary (BLOB, Float32 LE, 1536 dims), NOT HANA Vector(1536).
// Different column type ⇒ different write path ⇒ separate job (keeping them
// merged would invite "why did tutorial embeddings get seeded twice" bugs).
//
// Publish gate mirrors the read-side gate in
// srv/lib/kg/concept-embedding-query.js: status='ACTIVE'
// AND publishedAt IS NOT NULL AND mergedInto_ID IS NULL. Backfill semantics
// (embedding IS NULL) — the Concepts schema does not carry an `embeddedAt`
// column today, so full-catalog re-embed is a manual op (admin action
// wipes `embedding` on selected rows, then this cron catches them up).
//
// Locking: uses the same DB-backed JobLocks table as every other cron via
// job-lock.js. Distributed-safe across multiple CF instances.

import cds from '@sap/cds';
import { acquireLock, releaseLock } from './job-lock.js';
import { embed as embedInputs } from '../lib/embedding-client.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';

const LOG = cds.log('concept-embedding-backfill');
const LOCK_NAME = 'concept-embedding-backfill';
const DIMS = 1536;
const BYTES_PER_FLOAT = 4;

function encodeEmbedding(vec) {
  const buf = Buffer.alloc(vec.length * BYTES_PER_FLOAT);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * BYTES_PER_FLOAT);
  return buf;
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana';
}

async function resolveModel() {
  const { model } = await resolveEmbeddingSettings();
  return model;
}

async function fetchCandidates(db) {
  // Publish gate: ACTIVE + published + not merged; embedding IS NULL for backfill.
  // (Concepts has no embeddedAt column — schema-add is out of scope for #943.)
  if (isHana(db)) {
    return await db.run(
      `SELECT ID as id, SLUG as slug, NAME as name, DESCRIPTION as description
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE STATUS = 'ACTIVE'
         AND PUBLISHEDAT IS NOT NULL
         AND MERGEDINTO_ID IS NULL
         AND EMBEDDING IS NULL`
    ) || [];
  }
  return await db.run(
    `SELECT ID as id, slug, name, description
     FROM com_sap_developers_ims_Concepts
     WHERE status = 'ACTIVE'
       AND publishedAt IS NOT NULL
       AND mergedInto_ID IS NULL
       AND embedding IS NULL`
  ) || [];
}

/**
 * Adapt the shared `embed(inputs, model)` client to the single-string
 * `{ embed(text) => Promise<Float32Array> }` shape used across the KG code.
 * Callers may pass an injectable `embedClient` (tests do); otherwise this
 * builds one on top of the AI Core batching wrapper.
 */
function defaultEmbedClient(model) {
  return {
    async embed(text) {
      const [vec] = await embedInputs([text], model);
      return vec;
    },
  };
}

/**
 * One-shot backfill + reconciliation cycle.
 *
 * @param {object} [opts]
 * @param {object} [opts.db]            - CDS db handle; defaults to cds.connect.to('db')
 * @param {object} [opts.embedClient]   - { embed(text) => Promise<Float32Array> }
 * @param {object} [opts.telemetry]     - { emit(event, payload) } optional
 * @param {object} [opts.log]           - logger (defaults to cds.log)
 * @returns {Promise<{processed:number, failed:number, latencyMs:number, skipped?:boolean}>}
 */
export async function runConceptEmbeddingBackfill({ db, embedClient, telemetry, log = LOG } = {}) {
  const dbHandle = db ?? await cds.connect.to('db');
  const instanceId = process.env.CF_INSTANCE_INDEX || '0';
  const locked = await acquireLock(LOCK_NAME, instanceId, 30 * 60 * 1000);
  if (!locked) {
    log.info?.('[concept-backfill] skipped — another instance holds the lock');
    return { skipped: true, processed: 0, failed: 0, latencyMs: 0 };
  }

  const t0 = Date.now();
  let processed = 0;
  let failed = 0;

  try {
    const model = await resolveModel();
    const client = embedClient || defaultEmbedClient(model);
    const rows = await fetchCandidates(dbHandle);

    for (const r of rows) {
      const id = r.ID ?? r.id;
      const nm = r.NAME ?? r.name;
      const desc = r.DESCRIPTION ?? r.description;
      const text = [nm, desc].filter(Boolean).join(' — ');
      if (!text.trim()) {
        failed++;
        log.warn?.(`[concept-backfill] skipped ${id}: empty name+description`);
        continue;
      }
      try {
        const vec = await client.embed(text);
        if (!vec || vec.length !== DIMS) {
          throw new Error(`bad vector length ${vec?.length ?? 'null'}`);
        }
        const blob = encodeEmbedding(vec);
        if (isHana(dbHandle)) {
          await dbHandle.run(
            `UPDATE COM_SAP_DEVELOPERS_IMS_CONCEPTS SET EMBEDDING = ? WHERE ID = ?`,
            [blob, id]
          );
        } else {
          await dbHandle.run(
            `UPDATE com_sap_developers_ims_Concepts SET embedding = ? WHERE ID = ?`,
            [blob, id]
          );
        }
        processed++;
      } catch (err) {
        failed++;
        log.warn?.(`[concept-backfill] failed for ${id}: ${err.message}`);
      }
    }
  } finally {
    try {
      await releaseLock(LOCK_NAME, instanceId);
    } catch (err) {
      log.warn?.(`[concept-backfill] releaseLock failed: ${err.message}`);
    }
  }

  const summary = { processed, failed, latencyMs: Date.now() - t0 };
  telemetry?.emit?.('kg.joule.concept_backfill_ran', summary);
  log.info?.('[concept-backfill]', summary);
  return summary;
}
