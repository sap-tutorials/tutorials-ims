// srv/lib/kg-merge-on-write.js
//
// Shared merge-on-write primitive for the knowledge-graph.
//
// Two callers today:
//   - srv/jobs/extract-concepts-job.js (tutorial extraction; original home)
//   - srv/jobs/fetch-learning-journeys-job.js (Phase 4.1, #707)
//
// Sub-phases 4.2-4.6 (blog posts, missions, videos, api-docs, samples) will
// reuse the same primitive — that's the point of factoring it out.
//
// What it does:
//   1. loadConceptRegistry(db) → returns { bySlug, embeddings } maps for one
//      pass over the ACTIVE concepts. Callers cache this for a whole cron
//      cycle.
//   2. resolveConceptCandidates({...}) → takes a list of {slug, name?,
//      confidence} candidates and returns:
//        - resolved[]: [{slug, conceptId, action, confidence}] — one row per
//          input candidate that has a usable conceptId. `action` is one of
//          'exact' (slug already in registry), 'merged' (embedded near-dup
//          found above the threshold), 'minted' (deferred — see pendingMints).
//        - pendingMints[]: [{ID, slug, name, embeddingBuf}] — caller MUST
//          INSERT these into Concepts INSIDE its own tx before INSERTing any
//          FK-bearing row (links). The pre-allocated UUID is what's
//          referenced from `resolved[].conceptId` for the 'minted' rows.
//        - counters: {merged, minted, skippedNoEmbed} for the caller's
//          summary log.
//
// Why pendingMints is returned (not INSERTed inline): the caller owns its
// transaction. The tutorial cron writes Concepts + TutorialConceptLinks
// atomically per tutorial; the journey cron writes Concepts +
// LearningJourneyConceptLinks atomically per journey. Letting this helper
// commit Concepts on its own would force every caller into either:
//   (a) duplicate Concepts INSERTs across helpers, or
//   (b) a worse atomicity boundary (concept minted but link write fails).
// Pre-allocating the UUID lets the caller stage everything in one tx.
//
// Why embed `name` only (per #707 design decision): the tutorial cron's
// existing behavior. Keeping the embed input symmetric means a concept that
// would-merge from one path also would-merge from the other. Asymmetric
// embeds would split the registry over time.

import cds from '@sap/cds';
import { cosineSim } from './kg-similarity.js';

const NAMESPACE = 'com.sap.developers.ims';

function isHana(db) {
  return db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
}

/**
 * Load every ACTIVE concept's metadata + embedding via raw SQL on HANA,
 * CDS QL on SQLite. Mirrors the LOB-locator workaround used elsewhere
 * (srv/lib/embedding-query.js, srv/lib/content-store.js).
 *
 * @param {import('@sap/cds/apis/services').Service} db
 * @returns {Promise<{bySlug: Map<string, {ID: string, slug: string, name: string}>, embeddings: Map<string, Float32Array>}>}
 */
export async function loadConceptRegistry(db) {
  const bySlug = new Map();
  const embeddings = new Map();
  const retiredBySlug = new Map();

  const { Concepts } = cds.entities(NAMESPACE);

  // Metadata pass (CDS QL is safe — no LOB). Pull status so we can split
  // ACTIVE (dedup target + embed registry) from RETIRED (reactivation target).
  const metaRows = await SELECT.from(Concepts)
    .columns('ID', 'slug', 'name', 'status')
    .where({ status: { in: ['ACTIVE', 'RETIRED'] } });
  for (const r of metaRows) {
    if (!r.slug) continue;
    if (r.status === 'RETIRED') {
      retiredBySlug.set(r.slug, { ID: r.ID, slug: r.slug, name: r.name ?? '' });
    } else {
      bySlug.set(r.slug, { ID: r.ID, slug: r.slug, name: r.name ?? '' });
    }
  }

  // Embedding pass.
  if (isHana(db)) {
    const rows = await db.run(
      `SELECT "ID", "EMBEDDING" FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE "STATUS" = 'ACTIVE'`,
    );
    for (const r of rows) {
      const id = r.ID ?? r.id;
      const buf = r.EMBEDDING ?? r.embedding;
      if (!id || !buf) continue;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      embeddings.set(id, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
    }
  } else {
    // SQLite test path. @cap-js/sqlite may return BLOB columns as a Readable
    // stream when SELECTed alongside metadata — drain it before coercing.
    const rows = await SELECT.from(Concepts).columns('ID', 'embedding').where({ status: 'ACTIVE' });
    for (const r of rows) {
      if (!r.ID || !r.embedding) continue;
      const buf = await toBuffer(r.embedding);
      if (!buf) continue;
      embeddings.set(r.ID, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
  }

  return { bySlug, embeddings, retiredBySlug };
}

/**
 * Coerce an embedding column value to a Buffer. CDS may return:
 *   - a Buffer (HANA raw SQL path, and most SQLite versions)
 *   - a Uint8Array (some sqlite-builder versions)
 *   - a Readable stream (sqlite when BLOB is mixed with metadata in one SELECT)
 *   - a base64 string (some bind paths)
 */
async function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (typeof value.pipe === 'function' || typeof value.on === 'function') {
    const chunks = [];
    for await (const chunk of value) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return null;
}

/**
 * Find the highest-cosine-similarity ACTIVE concept for a candidate embedding.
 *
 * @param {Float32Array} candidateVec
 * @param {Map<string, Float32Array>} registryEmbeddings  conceptID → vector
 * @returns {{ conceptId: string|null, sim: number }}
 */
export function findBestMatch(candidateVec, registryEmbeddings) {
  let bestId = null;
  let best = -Infinity;
  for (const [id, vec] of registryEmbeddings) {
    if (vec.length !== candidateVec.length) continue;
    const s = cosineSim(candidateVec, vec);
    if (s > best) {
      best = s;
      bestId = id;
    }
  }
  return { conceptId: bestId, sim: best === -Infinity ? 0 : best };
}

/**
 * Resolve a list of {slug, name, confidence} candidates against the registry.
 * Returns the per-candidate decision plus a list of pending Concept mints the
 * caller MUST INSERT inside its own tx before referencing them.
 *
 * @param {object} input
 * @param {Array<{slug: string, name?: string, confidence: number}>} input.candidates
 * @param {{bySlug: Map<string, {ID: string, slug: string, name: string}>, embeddings: Map<string, Float32Array>}} input.registry
 * @param {Function} input.embed  (inputs[], modelName) → Float32Array[]
 * @param {string} input.embeddingModel
 * @param {number} input.mergeThreshold  cosine cutoff (e.g. 0.85)
 * @param {object} [input.log]            cds.log-shaped; optional
 * @returns {Promise<{
 *   resolved: Array<{slug: string, conceptId: string, action: 'exact'|'merged'|'minted', confidence: number}>,
 *   pendingMints: Array<{ID: string, slug: string, name: string, embeddingBuf: Buffer, embeddingVec: Float32Array}>,
 *   counters: {merged: number, minted: number, skippedNoEmbed: number},
 * }>}
 */
export async function resolveConceptCandidates({
  candidates,
  registry,
  embed,
  embeddingModel,
  mergeThreshold,
  log,
}) {
  const resolved = [];
  const pendingMints = [];
  const counters = { merged: 0, minted: 0, skippedNoEmbed: 0, reactivated: 0 };

  // Per-call dedup: if the same slug appears multiple times in `candidates`,
  // reuse the first decision (don't embed/mint twice in the same call).
  const newSlugToPendingId = new Map();

  for (const c of candidates) {
    if (!c.slug) continue;

    // 1. Exact slug match in the registry → done.
    const exact = registry.bySlug.get(c.slug);
    if (exact) {
      resolved.push({
        slug: c.slug,
        conceptId: exact.ID,
        action: 'exact',
        confidence: c.confidence,
      });
      continue;
    }

    // 2. Already pending from earlier in this call → reuse the pending ID.
    const alreadyPending = newSlugToPendingId.get(c.slug);
    if (alreadyPending) {
      resolved.push({
        slug: c.slug,
        conceptId: alreadyPending,
        action: 'minted',
        confidence: c.confidence,
      });
      continue;
    }

    // 2b. Retired slug re-proposed (#1115). Resolve to the retired concept's
    // ID with action 'reactivated'; the caller flips it back to ACTIVE in-tx.
    // Skipping the embed/mint avoids a UNIQUE(slug) violation on INSERT.
    const retired = registry.retiredBySlug?.get(c.slug);
    if (retired) {
      counters.reactivated++;
      log?.info?.(`resolveConceptCandidates: reactivating retired "${c.slug}" (${retired.ID})`);
      resolved.push({
        slug: c.slug,
        conceptId: retired.ID,
        action: 'reactivated',
        confidence: c.confidence,
      });
      continue;
    }

    // 3. Novel slug. Embed `name` (consistent with the tutorial cron — see
    //    header comment for why) and probe for a near-dup.
    if (!c.name) {
      counters.skippedNoEmbed++;
      log?.warn?.(`resolveConceptCandidates: candidate slug "${c.slug}" has no name; cannot embed`);
      continue;
    }
    let candidateVec;
    try {
      const [vec] = await embed([c.name], embeddingModel);
      candidateVec = vec;
    } catch (err) {
      counters.skippedNoEmbed++;
      log?.warn?.(`resolveConceptCandidates: embed failed for "${c.slug}": ${err.message}`);
      continue;
    }
    if (!candidateVec) {
      counters.skippedNoEmbed++;
      continue;
    }

    const match = findBestMatch(candidateVec, registry.embeddings);
    if (match.conceptId && match.sim > mergeThreshold) {
      counters.merged++;
      log?.info?.(
        `resolveConceptCandidates: merged "${c.slug}" into ${match.conceptId} (sim=${match.sim.toFixed(3)})`,
      );
      resolved.push({
        slug: c.slug,
        conceptId: match.conceptId,
        action: 'merged',
        confidence: c.confidence,
      });
      continue;
    }

    // 4. Mint. Pre-allocate UUID + embedding Buffer; caller INSERTs inside tx.
    const newId = cds.utils.uuid();
    const embeddingBuf = Buffer.from(
      candidateVec.buffer,
      candidateVec.byteOffset,
      candidateVec.byteLength,
    );
    pendingMints.push({
      ID: newId,
      slug: c.slug,
      name: c.name,
      embeddingBuf,
      // embeddingVec lets callers warm their in-memory registry post-tx
      // without re-decoding the Buffer. Required by extract-concepts-job's
      // page-scoped registry mutation pattern.
      embeddingVec: candidateVec,
    });
    newSlugToPendingId.set(c.slug, newId);
    counters.minted++;
    resolved.push({
      slug: c.slug,
      conceptId: newId,
      action: 'minted',
      confidence: c.confidence,
    });
  }

  return { resolved, pendingMints, counters };
}
