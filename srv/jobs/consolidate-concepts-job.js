// srv/jobs/consolidate-concepts-job.js
// Weekly knowledge-graph consolidation cron handler.
//
// Walks the ACTIVE Concepts registry, finds near-duplicate pairs by cosine
// similarity over their cached embedding vectors, deterministically picks the
// canonical winner, redirects FK references (TutorialConceptLinks +
// ConceptEdges), MERGED-flags the loser, then runs DFS cycle detection on the
// :requires edge graph and auto-VETOes the weakest edge in each cycle.
// Finishes with a full graphRebuild() so the downstream SPARQL graph reflects
// the freshly-canonicalised state.
//
// Distributed-locking + pipeline-log start/end are handled by the scheduler's
// runWithLock wrapper — this handler MUST NOT touch JobLocks itself.
//
// Configuration:
//   KG_MERGE_SIM_THRESHOLD — cosine similarity (0, 1] above which two concepts
//   collapse. Default 0.92. Setting it to 0 is a no-op dry-run (no pair will
//   ever satisfy the strict `>` test in findNearDuplicates).
//
// Plan ref: docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md
//           (PR 4 / Task 4.5)
// Spec ref: docs/superpowers/specs/2026-06-17-knowledge-graph-design.md
//           ("Extraction & consolidation pipeline")

import cds from '@sap/cds';
import { findNearDuplicates } from '../lib/kg-similarity.js';
import { findCycles } from '../lib/kg-cycles.js';
import { graphRebuild } from '../lib/kg-graph-rebuild.js';

const NAMESPACE = 'com.sap.developers.ims';
const DEFAULT_MERGE_THRESHOLD = 0.92;

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
function bufferToFloat32Array(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/**
 * Load every ACTIVE concept with the metadata + embedding the consolidator
 * needs (slug, name, extractionCount, firstSeenAt, embedding).
 *
 * Why raw SQL on HANA: HANA returns LargeBinary columns as a Readable stream
 * backed by a LOB locator that expires before consumption when SELECTed
 * alongside scalar columns in CDS QL. The raw-SQL escape hatch here mirrors
 * the established pattern in srv/lib/embedding-query.js +
 * srv/jobs/extract-concepts-job.js.
 *
 * @param {object} db
 * @param {object} log
 * @returns {Promise<Array<{ID, slug, name, extractionCount, firstSeenAt, embeddingVec}>>}
 */
async function loadConceptsWithEmbeddings(db, log) {
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
      log.warn(
        `consolidate-concepts: concept ${ID} (${slug}) has missing/malformed embedding — skipping from dedupe pass`,
      );
      continue;
    }
    out.push({ ID, slug, name, extractionCount, firstSeenAt, embeddingVec });
  }
  return out;
}

/**
 * Consolidate the concept graph: merge near-duplicates, auto-VETO cycle-causing
 * edges, then trigger a full graph rebuild.
 *
 * Dependencies are injected so a hybrid test can mock them (the extract job
 * uses the same convention):
 *   - db  : cds.connect.to('db')
 *   - log : cds.log
 *
 * @param {object}  [deps]
 * @param {string}  [_logId]  unused; reserved to mirror runWithLock(fn(logId)) signature.
 * @returns {Promise<object>} structured summary for formatJobSummary
 */
export async function runConsolidateConcepts(deps = {}, _logId) {
  const db = deps.db ?? (await cds.connect.to('db'));
  const log = deps.log ?? cds.log('consolidate-concepts');

  // Merge threshold: cosine similarity STRICTLY ABOVE this collapses two
  // concepts. Override via KG_MERGE_SIM_THRESHOLD (must be in (0, 1]).
  // Setting `0` is a no-op (nothing satisfies `> 0` for normalised vectors of
  // disjoint concepts; useful for a "skip merges, only run cycles+rebuild"
  // dry-run pass). Don't use `|| DEFAULT` — that swallows the explicit 0.
  const thresholdRaw = process.env.KG_MERGE_SIM_THRESHOLD;
  const thresholdParsed = thresholdRaw !== undefined ? Number(thresholdRaw) : NaN;
  const MERGE_THRESHOLD =
    Number.isFinite(thresholdParsed) && thresholdParsed >= 0 && thresholdParsed <= 1
      ? thresholdParsed
      : DEFAULT_MERGE_THRESHOLD;

  log.info(
    `consolidate-concepts: starting (KG_MERGE_SIM_THRESHOLD=${MERGE_THRESHOLD})`,
  );

  const { Concepts, ConceptEdges, TutorialConceptLinks } = cds.entities(NAMESPACE);

  // --------------------------------------------------------------------
  // Phase 1 — load concepts + find near-duplicate pairs
  // --------------------------------------------------------------------
  const concepts = await loadConceptsWithEmbeddings(db, log);
  const pairs = findNearDuplicates(concepts, MERGE_THRESHOLD);
  log.info(
    `consolidate-concepts: scanned ${concepts.length} concepts, found ${pairs.length} candidate pair(s) above threshold`,
  );

  // --------------------------------------------------------------------
  // Phase 2 — apply merges, tracking still-active concept IDs in-memory
  // so a chained pair (A→B and B→C) doesn't double-merge an already-MERGED
  // loser. findNearDuplicates returns pairs sorted by sim desc, so we apply
  // strongest matches first and skip any subsequent pair that touches a
  // now-MERGED loser.
  // --------------------------------------------------------------------
  const stillActive = new Set(concepts.map((c) => c.ID));
  let mergesPerformed = 0;
  let mergesSkipped = 0;

  for (const { canonical, loser, sim } of pairs) {
    if (!stillActive.has(canonical.ID) || !stillActive.has(loser.ID)) {
      mergesSkipped++;
      continue;
    }

    try {
      await db.tx(async (tx) => {
        // Redirect tutorial-level FK references onto the canonical.
        await tx.run(
          UPDATE(TutorialConceptLinks)
            .set({ concept_ID: canonical.ID })
            .where({ concept_ID: loser.ID }),
        );

        // Redirect both endpoints of any concept-to-concept edges that
        // referenced the loser.
        await tx.run(
          UPDATE(ConceptEdges)
            .set({ source_ID: canonical.ID })
            .where({ source_ID: loser.ID }),
        );
        await tx.run(
          UPDATE(ConceptEdges)
            .set({ target_ID: canonical.ID })
            .where({ target_ID: loser.ID }),
        );

        // Drop self-loops created by the redirect (e.g. an edge that used to
        // run loser→canonical now points canonical→canonical). We can't use
        // CDS QL's where() for a column=column predicate cleanly, so SELECT
        // the offending IDs first then DELETE by ID — keeps the statement
        // shape portable between HANA and the SQLite test path.
        const selfLoops = await tx.run(
          SELECT.from(ConceptEdges)
            .columns('ID', 'source_ID', 'target_ID')
            .where({ source_ID: canonical.ID, target_ID: canonical.ID }),
        );
        if (selfLoops.length > 0) {
          await tx.run(
            DELETE.from(ConceptEdges).where({ ID: { in: selfLoops.map((r) => r.ID) } }),
          );
        }

        // Flag the loser as MERGED and pin its mergedInto pointer.
        await tx.run(
          UPDATE(Concepts)
            .set({ status: 'MERGED', mergedInto_ID: canonical.ID })
            .where({ ID: loser.ID }),
        );
      });
      stillActive.delete(loser.ID);
      mergesPerformed++;
      log.info(
        `consolidate-concepts: merged "${loser.slug}" (${loser.ID}) into "${canonical.slug}" (${canonical.ID}) sim=${sim.toFixed(4)}`,
      );
    } catch (err) {
      log.error(
        `consolidate-concepts: merge failed for ${loser.ID} -> ${canonical.ID}: ${err.message ?? String(err)}`,
      );
    }
  }

  // --------------------------------------------------------------------
  // Phase 3 — cycle detection on :requires edges, auto-VETO weakest links
  // --------------------------------------------------------------------
  // ConceptEdges has no LOB columns, so CDS QL is safe here (no LOB-locator
  // expiry concerns).
  const edgeRows = await SELECT.from(ConceptEdges)
    .columns('ID', 'source_ID', 'target_ID', 'predicate', 'confidence')
    .where({ status: 'ACTIVE', predicate: 'requires' });

  const edgeFixtures = edgeRows.map((e) => ({
    id: e.ID,
    source: e.source_ID,
    target: e.target_ID,
    predicate: e.predicate,
    confidence: e.confidence,
  }));
  const { cycles, weakestEdges } = findCycles(edgeFixtures);

  for (const edgeId of weakestEdges) {
    try {
      await db.tx(async (tx) => {
        await tx.run(UPDATE(ConceptEdges).set({ status: 'VETOED' }).where({ ID: edgeId }));
      });
    } catch (err) {
      log.error(
        `consolidate-concepts: auto-VETO failed for edge ${edgeId}: ${err.message ?? String(err)}`,
      );
    }
  }
  if (cycles.length > 0) {
    log.warn(
      `consolidate-concepts: detected ${cycles.length} cycle(s); auto-VETOed ${weakestEdges.length} edge(s)`,
    );
  }

  // --------------------------------------------------------------------
  // Phase 4 — full graph rebuild so the SPARQL projection mirrors the
  // freshly canonicalised CDS state.
  // --------------------------------------------------------------------
  const rebuildResult = await graphRebuild({ db, log });

  const summary = {
    conceptsScanned: concepts.length,
    candidatePairs: pairs.length,
    mergesPerformed,
    mergesSkipped,
    cyclesDetected: cycles.length,
    edgesVetoed: weakestEdges.length,
    graphVersion: rebuildResult.graphVersion,
    tripleCount: rebuildResult.tripleCount,
    durationMs: rebuildResult.durationMs,
    mergeThreshold: MERGE_THRESHOLD,
  };
  log.info(
    `consolidate-concepts: done — ${Object.entries(summary)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  return summary;
}
