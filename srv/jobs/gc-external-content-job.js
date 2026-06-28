// srv/jobs/gc-external-content-job.js
//
// Phase 4 chassis: cross-type weekly GC.
//
// Scans each per-type entity, deletes rows where lastSeenAt + (TTL * 2) < NOW()
// AND pinUntil IS NULL OR pinUntil < NOW(). Double-TTL grace prevents
// accidental GC of rows about to be re-seen on the next fetch cycle.
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

    // Delete via CDS QL — no raw SQL.
    // Pattern: destructure the named entity from cds.entities(namespace) —
    // matches how the rest of the codebase accesses CDS entities. Direct
    // dynamic indexing (cds.entities(ns)[name]) isn't a documented API.
    const entities = cds.entities(NAMESPACE);
    const entity = entities[entityName];
    if (!entity) {
      LOG.warn(`gc-external-content: entity ${entityName} not found in CDS`);
      continue;
    }

    const deleted = await DELETE.from(entity).where({
      and: [
        { lastSeenAt: { '<': cutoff } },
        { or: [
          { pinUntil: null },
          { pinUntil: { '<': now } },
        ]},
      ],
    });

    summary[contentType] = `deleted=${deleted ?? 0}`;
    LOG.info(`gc-external-content: ${contentType} (${entityName}) — deleted ${deleted ?? 0} rows (cutoff=${cutoff})`);
  }

  return summary;
}
