// srv/jobs/kg-retire-orphans-job.js
//
// Nightly retirement of truly-orphaned concepts (#1115).
//
// A concept is retired (status ACTIVE → RETIRED) when it is:
//   - status = 'ACTIVE'
//   - older than KG_RETIRE_ORPHANS_AGE_DAYS (default 14) by firstSeenAt
//   - has ZERO links across all 10 tables: TutorialConceptLinks,
//     ConceptEdges (as source OR target, ACTIVE only), and the 8 external
//     *ConceptLinks (learning journeys, blog posts, videos, discovery
//     missions, api-docs, samples, help-docs, community events).
//
// RETIRED rows fall out of every read path automatically — all consumers
// filter status='ACTIVE' positively (cosine query, publish gate,
// loadConceptRegistry, kg-projection, admin projection). Nothing is deleted;
// the row + embedding + slug survive for trivial reversal. A re-proposed
// retired slug is flipped back to ACTIVE by the reactivate-on-collision path
// in kg-merge-on-write.js (#1115 Component D).
//
// QUERY FORM: raw db.run() with HANA/SQLite branching, identical to the
// pattern in srv/jobs/concept-embedding-backfill.js. The NOT EXISTS
// subqueries reference physical table names which differ between the two
// backends:
//   - SQLite (unit tests): mixed-case, e.g. com_sap_developers_ims_Concepts
//   - HANA (production):   ALL CAPS, e.g. COM_SAP_DEVELOPERS_IMS_CONCEPTS
// The CDS QL string-where form was tried first (as the brief's primary form)
// but @cap-js/db-service's cqn4sql transformer resolves subquery table names
// against CDS model definitions using the CDS entity name (dotted path mapped
// to underscores), not the physical table name — causing a "not found in
// definitions" error. Raw db.run() bypasses the CQL layer entirely.
//
// Fail-open: errors → metrics counter + LOG.error; rethrows so the
// scheduler can record a FAILED PipelineLog row.
//
// Spec: docs/superpowers/specs/2026-07-12-1115-kg-concept-durability-design.md
// Issue: #1115

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('kg-retire-orphans');

const UPDATE_BATCH_SIZE = 500;

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana';
}

/** Read KG_RETIRE_ORPHANS_AGE_DAYS; default 14, fall back on NaN/negative. */
export function readAgeDays() {
  const raw = process.env.KG_RETIRE_ORPHANS_AGE_DAYS;
  if (raw === undefined || raw === null || raw === '') return 14;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 14;
  return n;
}

/** Only the literal string 'false' disables; default enabled. */
export function isEnabled() {
  return process.env.KG_RETIRE_ORPHANS_ENABLED !== 'false';
}

// ---------------------------------------------------------------------------
// SQL templates for candidate SELECT.
//
// NOT EXISTS subqueries guard all 10 link tables. ConceptEdges is checked
// for both source and target directions using a single OR subquery (counts
// only ACTIVE edges to avoid VETOED edges blocking retirement).
//
// cutoffIso is a server-generated ISO-8601 string (e.g. '2026-06-28T09:00:00.000Z').
// No SQL injection surface — never constructed from user input.
//
// HANA: UPPERCASE table names; column aliases uppercase to normalize return.
// SQLite: mixed-case table names; column aliases lowercase.
// ---------------------------------------------------------------------------

function candidateSqlSqlite(cutoffIso) {
  return `
    SELECT ID
    FROM com_sap_developers_ims_Concepts c
    WHERE c.status = 'ACTIVE'
      AND c.firstSeenAt < '${cutoffIso}'
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_TutorialConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_ConceptEdges e
        WHERE (e.source_ID = c.ID OR e.target_ID = c.ID)
          AND e.status = 'ACTIVE'
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_LearningJourneyConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_BlogPostConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_VideoConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_DiscoveryMissionConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_ApiDocConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_SampleConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_HelpDocConceptLinks x
        WHERE x.concept_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM com_sap_developers_ims_external_CommunityEventConceptLinks x
        WHERE x.concept_ID = c.ID
      )
  `;
}

function candidateSqlHana(cutoffIso) {
  return `
    SELECT ID
    FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS c
    WHERE c.STATUS = 'ACTIVE'
      AND c.FIRSTSEENAT < '${cutoffIso}'
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES e
        WHERE (e.SOURCE_ID = c.ID OR e.TARGET_ID = c.ID)
          AND e.STATUS = 'ACTIVE'
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_LEARNINGJOURNEYCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_BLOGPOSTCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_VIDEOCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_DISCOVERYMISSIONCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_APIDOCCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_SAMPLECONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_HELPDOCCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
      AND NOT EXISTS (
        SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_EXTERNAL_COMMUNITYEVENTCONCEPTLINKS x
        WHERE x.CONCEPT_ID = c.ID
      )
  `;
}

export async function runRetireOrphans(deps = {}) {
  const t0 = Date.now();
  if (!isEnabled()) {
    return { reason: 'disabled', candidates: 0, retired: 0, durationMs: Date.now() - t0 };
  }
  const db = deps.db ?? (await cds.connect.to('db'));
  const ageDays = readAgeDays();
  const cutoffIso = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const hana = isHana(db);
    const sql = hana ? candidateSqlHana(cutoffIso) : candidateSqlSqlite(cutoffIso);
    const rows = await db.run(sql);
    // HANA returns column names uppercased; SQLite returns them as declared.
    const ids = rows.map((r) => r.ID ?? r.id);
    metrics.gauge('kg_retire_orphans_candidates', ids.length);

    const { Concepts } = cds.entities(NS);
    let retired = 0;
    if (ids.length > 0) {
      await db.tx(async (tx) => {
        for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
          const batch = ids.slice(i, i + UPDATE_BATCH_SIZE);
          await tx.run(UPDATE(Concepts).set({ status: 'RETIRED' }).where({ ID: { in: batch } }));
          retired += batch.length;
        }
      });
    }

    const durationMs = Date.now() - t0;
    metrics.observe('kg_retire_orphans_duration_ms', durationMs);
    metrics.gauge('kg_retire_orphans_retired_count', retired);
    LOG.info(`retire-orphans: ${ids.length} candidates → ${retired} retired (ageDays=${ageDays}, ${durationMs}ms)`);
    return { candidates: ids.length, retired, durationMs };
  } catch (err) {
    metrics.counter('kg_retire_orphans_failures');
    LOG.error('retire-orphans job failed', err);
    throw err;
  }
}
