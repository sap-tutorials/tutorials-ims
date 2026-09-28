// srv/lib/kg-merge-pair.js
// Per-pair concept merge — shared by the weekly consolidator
// (srv/jobs/consolidate-concepts-job.js) and the admin
// `KnowledgeGraphService.mergeConcepts` action.
//
// Why this lives in its own module
// --------------------------------
// Two separate call sites need byte-identical semantics:
//
//   1. The cron consolidator iterates over similarity pairs and calls this
//      helper inside a per-pair `db.tx`. Failure of one pair must not
//      poison sibling pairs (the consolidator catches and logs).
//
//   2. The admin `mergeConcepts(loser, canonical)` action invokes this once
//      and returns 4xx if the helper's invariants aren't met. The admin
//      caller asserts both IDs exist + are ACTIVE before calling.
//
// Both call sites need the same composite-PK collision pre-detection-and-
// delete logic — see [[feedback_composite_pk_collision_on_fk_redirect]]
// (memory captured 2026-06-17). Bulk UPDATE … SET concept_ID = canonical
// would violate @assert.unique.tutorialConcept (and the analogous
// @assert.unique.conceptEdge on ConceptEdges) when the canonical-row
// already exists for a given (tutorial, predicate) pair. The fix is to
// delete the loser-row first so the destination is unique.
//
// This module owns ONLY the per-pair state mutation. It does NOT trigger
// graphRebuild — both callers schedule their own rebuild (the cron rebuilds
// once at the end; the admin action fires-and-forgets after the response
// goes out). It does NOT hold a global mergeIsRunning lock — the cron is
// already lock-protected by runWithLock; admin actions are rare and
// idempotent on the UPDATE-by-loser-ID path.

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

/**
 * Apply a single canonical/loser merge inside a fresh transaction.
 *
 * The caller provides db (cds.connect.to('db')) and a logger; both are
 * forwarded to the cron's logging pipeline so consolidator and ad-hoc
 * admin merges land in the same audit channel.
 *
 * @param {object} args
 * @param {object} args.db               — cds db service
 * @param {object} args.log              — cds.log instance
 * @param {string} args.canonicalId      — survivor concept UUID
 * @param {string} args.loserId          — concept UUID to be flagged MERGED
 * @returns {Promise<{linksDeleted:number, edgesDeleted:number}>}
 *   Counts of collateral row-deletes performed during collision avoidance.
 *   Both call sites surface these in their structured summary.
 *
 * @throws Re-throws any DB error after logging — the caller decides whether
 *   to map to HTTP 4xx (admin path) or swallow per-pair (cron path).
 */
export async function mergeConceptPair({ db, log, canonicalId, loserId }) {
  if (!canonicalId || !loserId) {
    throw new Error('mergeConceptPair: canonicalId and loserId are required');
  }
  if (canonicalId === loserId) {
    throw new Error('mergeConceptPair: canonicalId and loserId must differ');
  }

  const { Concepts, ConceptEdges, TutorialConceptLinks } = cds.entities(NAMESPACE);

  let linksDeleted = 0;
  let edgesDeleted = 0;

  await db.tx(async (tx) => {
    // ---- Pre-detect-and-delete: TutorialConceptLinks ----
    // For (tutorial_ID, predicate) pairs that already have a canonical-row,
    // drop the matching loser-row before the bulk UPDATE so we don't
    // violate @assert.unique.tutorialConcept.
    const linkSurvivors = await tx.run(
      SELECT.from(TutorialConceptLinks)
        .columns('tutorial_ID', 'predicate')
        .where({ concept_ID: canonicalId }),
    );
    if (linkSurvivors.length > 0) {
      const survivorKeys = new Set(
        linkSurvivors.map((r) => `${r.tutorial_ID}:${r.predicate}`),
      );
      const loserLinks = await tx.run(
        SELECT.from(TutorialConceptLinks)
          .columns('ID', 'tutorial_ID', 'predicate')
          .where({ concept_ID: loserId }),
      );
      const collidingIds = loserLinks
        .filter((r) => survivorKeys.has(`${r.tutorial_ID}:${r.predicate}`))
        .map((r) => r.ID);
      if (collidingIds.length > 0) {
        await tx.run(
          DELETE.from(TutorialConceptLinks).where({ ID: { in: collidingIds } }),
        );
        linksDeleted += collidingIds.length;
      }
    }

    // Now safe: redirect remaining tutorial-level FK references.
    await tx.run(
      UPDATE(TutorialConceptLinks)
        .set({ concept_ID: canonicalId })
        .where({ concept_ID: loserId }),
    );

    // ---- Pre-detect-and-delete: ConceptEdges (source-redirect) ----
    const edgeSourceSurvivors = await tx.run(
      SELECT.from(ConceptEdges)
        .columns('target_ID', 'predicate')
        .where({ source_ID: canonicalId }),
    );
    if (edgeSourceSurvivors.length > 0) {
      const survivorKeys = new Set(
        edgeSourceSurvivors.map((r) => `${r.target_ID}:${r.predicate}`),
      );
      const loserEdgeSources = await tx.run(
        SELECT.from(ConceptEdges)
          .columns('ID', 'target_ID', 'predicate')
          .where({ source_ID: loserId }),
      );
      const collidingIds = loserEdgeSources
        .filter((r) => survivorKeys.has(`${r.target_ID}:${r.predicate}`))
        .map((r) => r.ID);
      if (collidingIds.length > 0) {
        await tx.run(
          DELETE.from(ConceptEdges).where({ ID: { in: collidingIds } }),
        );
        edgesDeleted += collidingIds.length;
      }
    }

    // Redirect source endpoints.
    await tx.run(
      UPDATE(ConceptEdges)
        .set({ source_ID: canonicalId })
        .where({ source_ID: loserId }),
    );

    // ---- Pre-detect-and-delete: ConceptEdges (target-redirect) ----
    const edgeTargetSurvivors = await tx.run(
      SELECT.from(ConceptEdges)
        .columns('source_ID', 'predicate')
        .where({ target_ID: canonicalId }),
    );
    if (edgeTargetSurvivors.length > 0) {
      const survivorKeys = new Set(
        edgeTargetSurvivors.map((r) => `${r.source_ID}:${r.predicate}`),
      );
      const loserEdgeTargets = await tx.run(
        SELECT.from(ConceptEdges)
          .columns('ID', 'source_ID', 'predicate')
          .where({ target_ID: loserId }),
      );
      const collidingIds = loserEdgeTargets
        .filter((r) => survivorKeys.has(`${r.source_ID}:${r.predicate}`))
        .map((r) => r.ID);
      if (collidingIds.length > 0) {
        await tx.run(
          DELETE.from(ConceptEdges).where({ ID: { in: collidingIds } }),
        );
        edgesDeleted += collidingIds.length;
      }
    }

    await tx.run(
      UPDATE(ConceptEdges)
        .set({ target_ID: canonicalId })
        .where({ target_ID: loserId }),
    );

    // Drop self-loops created by the redirect (e.g. an edge that used to
    // run loser→canonical now points canonical→canonical).
    const selfLoops = await tx.run(
      SELECT.from(ConceptEdges)
        .columns('ID')
        .where({ source_ID: canonicalId, target_ID: canonicalId }),
    );
    if (selfLoops.length > 0) {
      await tx.run(
        DELETE.from(ConceptEdges).where({ ID: { in: selfLoops.map((r) => r.ID) } }),
      );
    }

    // Flag the loser as MERGED and pin its mergedInto pointer.
    await tx.run(
      UPDATE(Concepts)
        .set({ status: 'MERGED', mergedInto_ID: canonicalId })
        .where({ ID: loserId }),
    );
  });

  if (log && typeof log.info === 'function') {
    log.info(
      `kg-merge-pair: merged ${loserId} into ${canonicalId} (linksDeleted=${linksDeleted}, edgesDeleted=${edgesDeleted})`,
    );
  }

  return { linksDeleted, edgesDeleted };
}
