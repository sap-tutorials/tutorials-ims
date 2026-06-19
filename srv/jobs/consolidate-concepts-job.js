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
import { mergeConceptPair } from '../lib/kg-merge-pair.js';
import { loadConceptsWithEmbeddings } from '../lib/kg-concept-loader.js';

const NAMESPACE = 'com.sap.developers.ims';
const DEFAULT_MERGE_THRESHOLD = 0.92;

// loadConceptsWithEmbeddings + bufferToFloat32Array were extracted to
// srv/lib/kg-concept-loader.js (PR 6 of #381) so the previewMerges admin
// action can share the same loader without duplicating LOB-locator logic.

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

  const { ConceptEdges } = cds.entities(NAMESPACE);

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
  // Per-pair merge: see srv/lib/kg-merge-pair.js for composite-PK collision rationale.
  let linksDeleted = 0;
  let edgesDeleted = 0;

  for (const { canonical, loser, sim } of pairs) {
    if (!stillActive.has(canonical.ID) || !stillActive.has(loser.ID)) {
      mergesSkipped++;
      continue;
    }

    try {
      const counts = await mergeConceptPair({
        db,
        log,
        canonicalId: canonical.ID,
        loserId: loser.ID,
      });
      linksDeleted += counts.linksDeleted;
      edgesDeleted += counts.edgesDeleted;
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
  //
  // OPTIMIZATION: when nothing changed (no merges performed AND no edges
  // auto-VETOed), skip graphRebuild entirely. The SPARQL projection of
  // the (unchanged) CDS state would produce the same triples and the
  // same graphVersion semantics; PR 5's read-cache invalidates on
  // graphVersion change, so a no-op weekly tick that does NOT bump the
  // version is correct (steady-state cached reads remain valid).
  //
  // We still report a coherent summary by reading the current
  // GraphMetadata singleton.
  // --------------------------------------------------------------------
  let rebuildResult;
  if (mergesPerformed === 0 && weakestEdges.length === 0) {
    log.info('consolidate-concepts: no changes; graph rebuild skipped');
    const { GraphMetadata } = cds.entities(NAMESPACE);
    const current = await SELECT.one
      .from(GraphMetadata)
      .columns('graphVersion', 'tripleCount', 'durationMs');
    rebuildResult = {
      graphVersion: current?.graphVersion ?? null,
      tripleCount: current?.tripleCount ?? 0,
      durationMs: 0,
    };
  } else {
    rebuildResult = await graphRebuild({ db, log });
  }

  const summary = {
    conceptsScanned: concepts.length,
    candidatePairs: pairs.length,
    mergesPerformed,
    mergesSkipped,
    linksDeleted,
    edgesDeleted,
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
