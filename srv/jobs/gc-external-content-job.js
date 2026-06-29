// srv/jobs/gc-external-content-job.js
//
// Phase 4 chassis: cross-type weekly GC.
//
// Scans each per-type entity, deletes rows where lastSeenAt + (TTL * 2) < NOW()
// AND pinUntil IS NULL OR pinUntil < NOW(). Double-TTL grace prevents
// accidental GC of rows about to be re-seen on the next fetch cycle.
//
// Cascade semantics:
//   - LearningJourneys → LearningJourneyConceptLinks (Composition; auto-cascade)
//   - LearningJourneys → LearningJourneyPrerequisites (Composition on the
//     `journey` side; auto-cascade)
//   - LearningJourneyPrerequisites.prerequisite — sibling Association, NOT
//     part of the composition tree. We sweep dangling prereq-side rows
//     explicitly before the parent DELETE so the schema invariant holds.
//
// 4.1 scans only LearningJourneys. 4.2-4.6 extend the ITERATION_SET.
//
// Spec: docs/superpowers/specs/2026-06-28-447-knowledge-graph-phase4-architecture.md §5.4

import cds from '@sap/cds';
import { PER_TYPE_TTL_DAYS } from '../lib/external-content-ttl.js';

const LOG = cds.log('gc-external-content');
const NAMESPACE = 'com.sap.developers.ims.external';

/**
 * Map from content-type → CDS entity name. 4.2-4.6 add entries.
 */
const ITERATION_SET = {
  'learning-journey': 'LearningJourneys',
  'blog-post': 'BlogPosts',  // Phase 4.2 (#447)
  'discovery-mission': 'DiscoveryMissions',  // Phase 4.3 (#447)
  'video': 'Videos',  // Phase 4.4 (#447)
  'api-doc': 'ApiDocs',  // Phase 4.5 (#746)
};

export async function runGcExternalContent() {
  // Connect for side-effect — keeps the call path symmetric with other jobs
  // even though the DELETE statements below are issued against CDS entities
  // not the connection directly.
  if (!cds.db) await cds.connect.to('db');
  const summary = {};

  for (const [contentType, entityName] of Object.entries(ITERATION_SET)) {
    const ttlDays = PER_TYPE_TTL_DAYS[contentType];
    if (ttlDays == null) {
      // Date-aware types (trials) need a different prune predicate; skip in
      // this generic pass. 4.3 will add a trial-specific branch.
      LOG.info(`gc-external-content: skipping ${contentType} (date-aware, separate pass)`);
      summary[contentType] = 'skipped-date-aware';
      continue;
    }

    const cutoffMs = Date.now() - (ttlDays * 2 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(cutoffMs).toISOString();
    const now = new Date().toISOString();

    // Look up entities via cds.entities(namespace). Destructuring keeps the
    // call path symmetric with the rest of the codebase.
    const entities = cds.entities(NAMESPACE);
    const entity = entities[entityName];
    if (!entity) {
      LOG.warn(`gc-external-content: entity ${entityName} not found in CDS`);
      continue;
    }

    // 1. Collect the IDs of stale rows.
    //    The nested-object form (`{ and: [...] }` / `{ or: [...] }`) generates
    //    malformed SQL on SQLite and is brittle on HANA. Tagged-template
    //    spelling with parameters is the safe, idiomatic CDS QL form.
    const stale = await SELECT.from(entity).columns('ID').where`
      lastSeenAt < ${cutoff} and (pinUntil is null or pinUntil < ${now})
    `;

    if (stale.length === 0) {
      summary[contentType] = 'deleted=0';
      LOG.debug(`gc-external-content: ${contentType} (${entityName}) — no rows to prune (cutoff=${cutoff})`);
      continue;
    }

    const staleIds = stale.map((r) => r.ID);

    // 2. Sweep dangling sibling-Association references. Compositions cascade
    //    the `journey` side, but the `prerequisite` side of
    //    LearningJourneyPrerequisites is a sibling Association — a journey
    //    that's GC-eligible may still be referenced as a prerequisite by
    //    OTHER (non-stale) journeys, which would leave dangling FK refs.
    //    Hand-coded sweeps live here per content-type; 4.2-4.6 add their
    //    own branches as needed.
    if (entityName === 'LearningJourneys') {
      const { LearningJourneyPrerequisites } = entities;
      if (LearningJourneyPrerequisites) {
        await DELETE.from(LearningJourneyPrerequisites).where({
          prerequisite_ID: { in: staleIds },
        });
      }
    }

    // 3. Delete the parent rows. CAP cascades the journey-side compositions
    //    (LearningJourneyConceptLinks rows + LearningJourneyPrerequisites
    //    rows where journey_ID is in staleIds).
    const deleted = await DELETE.from(entity).where({ ID: { in: staleIds } });

    summary[contentType] = `deleted=${deleted ?? 0}`;
    if (deleted > 0) {
      LOG.info(`gc-external-content: ${contentType} (${entityName}) — deleted ${deleted} rows (cutoff=${cutoff})`);
    } else {
      LOG.debug(`gc-external-content: ${contentType} (${entityName}) — no rows to prune (cutoff=${cutoff})`);
    }
  }

  return summary;
}
