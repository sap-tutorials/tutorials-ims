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
import { deleteInChunks } from './cleanup.js';

const LOG = cds.log('gc-external-content');
const NAMESPACE = 'com.sap.developers.ims.external';

/**
 * Map from content-type → CDS entity name. 4.2-4.6 add entries.
 */
export const ITERATION_SET = {
  'learning-journey': 'LearningJourneys',
  'blog-post': 'BlogPosts',  // Phase 4.2 (#447)
  'discovery-mission': 'DiscoveryMissions',  // Phase 4.3 (#447)
  'video': 'Videos',  // Phase 4.4 (#447)
  'api-doc': 'ApiDocs',  // Phase 4.5 (#746)
  'sample': 'Samples',  // Phase 4.6 (#747)
  'help-doc': 'HelpDocs',  // Phase 4.7 (#748)
  'community-event': 'CommunityEvents',  // Phase 4.8 (#765)
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
      // Date-aware types. Phase 4.8 (#765) activates this branch for community
      // events. Prune predicate: COALESCE(endDate, startDate) + 30 days < today.
      if (contentType === 'community-event') {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const nowStr = new Date().toISOString();
        const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
        // Tagged-template syntax is safe on both SQLite and HANA (matches the
        // pattern used for the standard TTL SELECT above). The object/or form
        // generates malformed SQL on SQLite.
        const stale = await SELECT.from(CommunityEvents).columns('ID', 'slug').where`
          (
            (endDate is not null and endDate < ${cutoff})
            or
            (endDate is null and startDate < ${cutoff})
          )
          and (pinUntil is null or pinUntil < ${nowStr})
        `;
        let pruned = 0;
        for (const row of stale) {
          await DELETE.from(CommunityEvents).where({ ID: row.ID });
          pruned++;
        }
        LOG.info(`gc-external-content: pruned ${pruned} community-event rows past endDate + 30d`);
        summary[contentType] = { pruned };
        continue;
      }
      LOG.info(`gc-external-content: skipping ${contentType} (date-aware, no branch)`);
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
    //
    //    Both DELETEs below chunk the ID IN-list via `deleteInChunks` from
    //    srv/jobs/cleanup.js — with HelpDocs (potentially thousands of
    //    scraped SAP Help pages) and Videos, staleIds can exceed HANA's
    //    packet cap (memory: cqn-where-in-hana-packet-cap.md).
    if (entityName === 'LearningJourneys') {
      const { LearningJourneyPrerequisites } = entities;
      if (LearningJourneyPrerequisites) {
        await deleteInChunks(LearningJourneyPrerequisites, 'prerequisite_ID', staleIds);
      }
    }

    // 3. Delete the parent rows. CAP cascades the journey-side compositions
    //    (LearningJourneyConceptLinks rows + LearningJourneyPrerequisites
    //    rows where journey_ID is in staleIds).
    const deleted = await deleteInChunks(entity, 'ID', staleIds);

    summary[contentType] = `deleted=${deleted ?? 0}`;
    if (deleted > 0) {
      LOG.info(`gc-external-content: ${contentType} (${entityName}) — deleted ${deleted} rows (cutoff=${cutoff})`);
    } else {
      LOG.debug(`gc-external-content: ${contentType} (${entityName}) — no rows to prune (cutoff=${cutoff})`);
    }
  }

  return summary;
}
