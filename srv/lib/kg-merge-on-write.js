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

/**
 * Serialize a Float32Array to the JSON-array literal HANA's TO_REAL_VECTOR(?)
 * expects. Full Float32 precision — no lossy toFixed() rounding (#1123). The
 * SQLite path stores the same string directly in the Vector(1536) column so
 * unit tests can observe the column is populated.
 *
 * @param {Float32Array|number[]} vec
 * @returns {string} e.g. "[0.123,0.456,...]"
 */
export function vectorToJsonLiteral(vec) {
  return JSON.stringify(Array.from(vec));
}

/**
 * INSERT one minted Concept, populating BOTH the legacy `embedding` BLOB
 * (full-precision Float32-LE, source of truth for dedup/consolidation) AND
 * the `embeddingVec` Vector(1536) column at mint time (#1123). Previously
 * only the BLOB was written and `embeddingVec` was backfilled later by an
 * async cron — meaning freshly-minted concepts were invisible to the HANA
 * native cosine search until the next backfill pass. Writing both here closes
 * that window.
 *
 * Why INSERT-then-UPDATE (not a single raw INSERT like embedding-pipeline.js):
 * Concepts is `cuid, managed` with `@cds.on.insert: firstSeenAt = $now`. A raw
 * `INSERT INTO ... VALUES (...)` bypasses CAP's managed-field + default-value
 * handling. Keeping the CQL INSERT preserves createdAt/modifiedAt/firstSeenAt
 * and the status/extractionCount defaults; the follow-up UPDATE only sets the
 * one column CQL can't express (TO_REAL_VECTOR is not valid CQL).
 *
 * On SQLite (unit tests) there is no REAL_VECTOR type — the Vector column is a
 * plain column, so the JSON-array string goes in with the CQL INSERT directly
 * and no follow-up UPDATE is needed.
 *
 * @param {object} args
 * @param {import('@sap/cds/apis/services').Service} args.db  db service (HANA detection)
 * @param {object} [args.tx]  optional active transaction (extract-concepts-job wraps mints in db.tx); defaults to db
 * @param {object} args.entry  the Concepts row: { ID, slug, name, description?, embeddingBuf, embeddingVec, status?, extractionCount?, lastSeenAt }
 *
 * ACTIVE-slug uniqueness guard (KG vertex-dup bug, Layer B): before INSERTing
 * a fresh row this helper re-checks the LIVE Concepts table for the slug and
 * reuses/reactivates any existing row instead of minting a duplicate. It is
 * the enforcement point for the "at most one ACTIVE row per slug" invariant
 * that @assert.unique cannot guarantee here (raw db.tx writers bypass the
 * service layer; a partial UNIQUE(slug) WHERE status='ACTIVE' is inexpressible
 * in HDI). Returns the ID that actually persists for the slug so the caller
 * can point its FK links + in-cycle registry at it rather than a phantom UUID.
 *
 * @returns {Promise<{ ID: string, action: 'minted'|'reused'|'reactivated' }>}
 */
export async function insertMintedConcept({ db, tx, entry }) {
  const runner = tx ?? db;
  const { Concepts } = cds.entities(NAMESPACE);
  const vecLiteral =
    entry.embeddingVec != null ? vectorToJsonLiteral(entry.embeddingVec) : null;

  // Guard: re-check the LIVE table for an existing row with this slug before
  // minting. No LOB column selected → safe to run against HANA inside the tx.
  // Closes the mint race in resolveConceptCandidates: the registry snapshot is
  // cached for a whole cron cycle, so a slug retired (or minted by a sibling
  // job) AFTER the snapshot lands in neither bySlug nor retiredBySlug and would
  // otherwise fall through to a fresh mint — a SECOND ACTIVE row for a slug that
  // already exists. Two ACTIVE rows make KG_PG_VERTICES_V emit the concept
  // vertex key twice, which crashes all three KG jobs (kg-pagerank,
  // kg-communities/Louvain, kg-wcc). @assert.unique on Concepts.slug is a CAP
  // RUNTIME check only and never fires here — every KG writer reaches this
  // helper via raw db/db.tx, not the service layer — and a partial
  // UNIQUE(slug) WHERE status='ACTIVE' cannot be expressed in HDI artifacts,
  // so the invariant MUST be enforced in app code at this write point.
  // slug-canonical: pre-canonicalized
  const existing = await runner.run(
    // slug-canonical: pre-canonicalized
    SELECT.from(Concepts).columns('ID', 'status').where({ slug: entry.slug }),
  );
  if (existing.length > 0) {
    // Deterministic pick if the table already carries duplicates: prefer an
    // ACTIVE row, else a RETIRED one; break ties on ID so re-runs converge on
    // the same survivor (matches KG_PG_VERTICES_V's ROW_NUMBER tiebreaker).
    const statusOf = (r) => r.status ?? r.STATUS;
    const idOf = (r) => r.ID ?? r.id;
    const byId = (a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
    const active = existing.filter((r) => statusOf(r) === 'ACTIVE').sort(byId);
    if (active.length > 0) {
      // Already ACTIVE — reuse it, never insert a second ACTIVE row.
      return { ID: idOf(active[0]), action: 'reused' };
    }
    const retired = existing.filter((r) => statusOf(r) === 'RETIRED').sort(byId);
    if (retired.length > 0) {
      // Dormant row for this slug — reactivate rather than mint (#1115),
      // closing the mid-cycle retire race the cached registry missed.
      const reuseId = idOf(retired[0]);
      await runner.run(
        UPDATE(Concepts)
          .set({ status: 'ACTIVE', lastSeenAt: entry.lastSeenAt })
          .where({ ID: reuseId }),
      );
      return { ID: reuseId, action: 'reactivated' };
    }
    // Only MERGED/VETOED rows exist for this slug: those are intentional
    // terminal states, not dedup targets — fall through and mint fresh.
  }

  const row = {
    ID: entry.ID,
    slug: entry.slug,
    name: entry.name,
    description: entry.description ?? '',
    embedding: entry.embeddingBuf,
    status: entry.status ?? 'ACTIVE',
    extractionCount: entry.extractionCount ?? 0,
    lastSeenAt: entry.lastSeenAt,
  };

  if (isHana(db)) {
    // CQL INSERT keeps managed/cuid/@cds.on.insert handling; the Vector column
    // is set by the follow-up raw UPDATE because TO_REAL_VECTOR isn't valid CQL.
    await runner.run(INSERT.into(Concepts).entries(row));
    if (vecLiteral != null) {
      await runner.run(
        `UPDATE "COM_SAP_DEVELOPERS_IMS_CONCEPTS" SET "EMBEDDINGVEC" = TO_REAL_VECTOR(?) WHERE "ID" = ?`,
        [vecLiteral, entry.ID],
      );
    }
  } else {
    // SQLite: no REAL_VECTOR type — store the JSON-array string in the column
    // directly alongside the CQL INSERT.
    await runner.run(INSERT.into(Concepts).entries({ ...row, embeddingVec: vecLiteral }));
  }
  return { ID: entry.ID, action: 'minted' };
}
