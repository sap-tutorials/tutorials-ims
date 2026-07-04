// test/hybrid/kg-wcc.test.js
//
// End-to-end hybrid test — seeds an isolated/hub fixture in the LIVE
// DEV HDI, drives runKgWcc(), and verifies:
//   1. Isolated concept + isolated tutorial land in KgIsolation with
//      componentSize=1 at the default threshold (1).
//   2. Hub cluster (4 vertices linked via requires + teaches) does
//      NOT land in KgIsolation at threshold=1.
//   3. Bumping the threshold to 4 makes the hub cluster get flagged
//      too (componentSize=4 <= 4).
//   4. SELECT from KnowledgeGraphService.Concepts and
//      AdminService.Tutorials returns `isolated: true` for the
//      flagged fixtures via the after('READ') decorators.
//
// SAFETY
//   All fixtures use TEST_PREFIX `__test__kg-wcc-`. afterAll cleans up
//   via LOWER(slug) LIKE. Gated by ALLOW_HYBRID_WRITES via _guard.js.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-wcc.test.js
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { runKgWcc } from '../../srv/jobs/kg-wcc-job.js';

const TEST_PREFIX = `__test__kg-wcc-`;   // lowercase — matches slug canonicalization
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const ISO_C  = `${TEST_PREFIX}${RUN_ID}-iso-c`;
const HUB_A  = `${TEST_PREFIX}${RUN_ID}-hub-c-a`;
const HUB_B  = `${TEST_PREFIX}${RUN_ID}-hub-c-b`;

const ISO_T  = `${TEST_PREFIX}${RUN_ID}-iso-t`;
const HUB_TA = `${TEST_PREFIX}${RUN_ID}-hub-t-a`;
const HUB_TB = `${TEST_PREFIX}${RUN_ID}-hub-t-b`;

const NS = 'com.sap.developers.ims';
const KGS = 'KnowledgeGraphService';
const AS  = 'AdminService';

const skip = !isSafeForWrites() || process.env.ALLOW_HYBRID_WRITES !== 'true';

describe.skipIf(skip)('runKgWcc hybrid — seeds isolated/hub fixture + verifies sidecar + projection', () => {
  let db;
  const seededConceptIds  = [];
  const seededTutorialIds = [];
  const seededEdgeIds     = [];
  const seededLinkIds     = [];

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Concepts, Tutorials, ConceptEdges, TutorialConceptLinks } = cds.entities(NS);

    // 3 concepts: 1 isolated + 2 hub. Ordering: Concepts first for FK
    // integrity when the ConceptEdge insert follows.
    const isoConceptId  = crypto.randomUUID();
    const hubAConceptId = crypto.randomUUID();
    const hubBConceptId = crypto.randomUUID();
    seededConceptIds.push(isoConceptId, hubAConceptId, hubBConceptId);
    await db.run(INSERT.into(Concepts).entries([
      { ID: isoConceptId,  slug: ISO_C, name: 'Isolated Concept',  status: 'ACTIVE' },
      { ID: hubAConceptId, slug: HUB_A, name: 'Hub Concept A',     status: 'ACTIVE' },
      { ID: hubBConceptId, slug: HUB_B, name: 'Hub Concept B',     status: 'ACTIVE' },
    ]));

    // 3 tutorials: 1 isolated + 2 hub. Tutorials.legacyId must be
    // unique + non-null per the schema; use the runId as a suffix to
    // keep it collision-free.
    const isoTutId  = crypto.randomUUID();
    const hubTAId   = crypto.randomUUID();
    const hubTBId   = crypto.randomUUID();
    seededTutorialIds.push(isoTutId, hubTAId, hubTBId);
    await db.run(INSERT.into(Tutorials).entries([
      { ID: isoTutId, slug: ISO_T,  title: 'Isolated Tutorial',  legacyId: `wcc-${RUN_ID}-iso`, status: 'ACTIVE' },
      { ID: hubTAId,  slug: HUB_TA, title: 'Hub Tutorial A',     legacyId: `wcc-${RUN_ID}-ha`,  status: 'ACTIVE' },
      { ID: hubTBId,  slug: HUB_TB, title: 'Hub Tutorial B',     legacyId: `wcc-${RUN_ID}-hb`,  status: 'ACTIVE' },
    ]));

    // Hub concept A --requires--> Hub concept B. This unifies both
    // hub concepts into one WCC.
    const edgeId = crypto.randomUUID();
    seededEdgeIds.push(edgeId);
    await db.run(INSERT.into(ConceptEdges).entries([
      { ID: edgeId, source_ID: hubAConceptId, target_ID: hubBConceptId, predicate: 'requires', status: 'ACTIVE' },
    ]));

    // Hub tutorial A teaches hub concept A, hub tutorial B teaches
    // hub concept B. Combined with the requires edge, all four hub
    // vertices are one component of size 4.
    const linkAId = crypto.randomUUID();
    const linkBId = crypto.randomUUID();
    seededLinkIds.push(linkAId, linkBId);
    await db.run(INSERT.into(TutorialConceptLinks).entries([
      { ID: linkAId, tutorial_ID: hubTAId, concept_ID: hubAConceptId, predicate: 'teaches' },
      { ID: linkBId, tutorial_ID: hubTBId, concept_ID: hubBConceptId, predicate: 'teaches' },
    ]));

    // NOTE: the isolated concept + isolated tutorial have NO edges,
    // so they land in size-1 components.
  }, 120000);

  afterAll(async () => {
    if (!db) return;
    const { Concepts, Tutorials, ConceptEdges, TutorialConceptLinks } = cds.entities(NS);

    // FK-safe teardown order: links → edges → tutorials → concepts.
    if (seededLinkIds.length) await db.run(DELETE.from(TutorialConceptLinks).where({ ID: { in: seededLinkIds } }));
    if (seededEdgeIds.length) await db.run(DELETE.from(ConceptEdges).where({ ID: { in: seededEdgeIds } }));
    if (seededTutorialIds.length) await db.run(DELETE.from(Tutorials).where({ ID: { in: seededTutorialIds } }));
    if (seededConceptIds.length) await db.run(DELETE.from(Concepts).where({ ID: { in: seededConceptIds } }));

    // Also nuke any fixture rows the job wrote to KgIsolation. The
    // job's TRUNCATE-INSERT means the whole table gets replaced each
    // run; this guarantees no leftover fixture pollution if a run
    // bails early.
    await db.run(
      `DELETE FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" WHERE LOWER(SLUG) LIKE ?`,
      [`${TEST_PREFIX}${RUN_ID}-%`.toLowerCase()],
    );

    // Restore env for downstream tests running in the same process.
    process.env.KG_WCC_ISOLATION_THRESHOLD = '1';
  }, 120000);

  it('flags size-1 components at threshold 1; hub cluster is not flagged', async () => {
    process.env.KG_WCC_ISOLATION_THRESHOLD = '1';
    const { componentCount, isolatedCount } = await runKgWcc();
    expect(componentCount).toBeGreaterThan(0);
    expect(isolatedCount).toBeGreaterThan(0);   // at least our two isolated fixtures

    const rows = await db.run(
      `SELECT VERTEXTYPE, SLUG, COMPONENTSIZE FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
      `WHERE LOWER(SLUG) LIKE ? ORDER BY VERTEXTYPE, SLUG`,
      [`${TEST_PREFIX}${RUN_ID}-%`.toLowerCase()],
    );
    // Expect exactly two: the isolated concept + the isolated tutorial.
    // Hub cluster's four vertices are all in one component of size 4, > threshold=1.
    expect(rows.length).toBe(2);
    const byType = Object.fromEntries(rows.map((r) => [r.VERTEXTYPE, r]));
    expect(byType.concept?.SLUG).toBe(ISO_C);
    expect(byType.concept?.COMPONENTSIZE).toBe(1);
    expect(byType.tutorial?.SLUG).toBe(ISO_T);
    expect(byType.tutorial?.COMPONENTSIZE).toBe(1);
  }, 120000);

  it('flags larger components when the threshold is raised to 4', async () => {
    process.env.KG_WCC_ISOLATION_THRESHOLD = '4';
    await runKgWcc();

    const rows = await db.run(
      `SELECT VERTEXTYPE, SLUG, COMPONENTSIZE FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
      `WHERE LOWER(SLUG) LIKE ?`,
      [`${TEST_PREFIX}${RUN_ID}-%`.toLowerCase()],
    );
    // Now all six fixture vertices are flagged: two isolates (size 1)
    // + four hub vertices (size 4). Every hub row has COMPONENTSIZE=4.
    expect(rows.length).toBe(6);
    const hub = rows.filter((r) => r.SLUG !== ISO_C && r.SLUG !== ISO_T);
    expect(hub.length).toBe(4);
    for (const r of hub) expect(r.COMPONENTSIZE).toBe(4);

    // Reset env so the projection test below sees the default threshold.
    process.env.KG_WCC_ISOLATION_THRESHOLD = '1';
    await runKgWcc();
  }, 120000);

  it('surfaces isolated=true on KnowledgeGraphService.Concepts and AdminService.Tutorials', async () => {
    // Both READs go through the after('READ') decorators added in Task 4.
    // The job left the sidecar at threshold=1 from the previous test's reset.
    const kgs   = await cds.connect.to(KGS);
    const admin = await cds.connect.to(AS);

    const { Concepts } = cds.entities(KGS);
    const conceptRows = await kgs.run(SELECT.from(Concepts).where({ slug: ISO_C }));
    expect(conceptRows.length).toBe(1);
    expect(conceptRows[0].isolated).toBe(true);

    const hubConceptRows = await kgs.run(SELECT.from(Concepts).where({ slug: HUB_A }));
    expect(hubConceptRows.length).toBe(1);
    // Hub is NOT isolated at threshold=1.
    expect(hubConceptRows[0].isolated === false || hubConceptRows[0].isolated == null).toBe(true);

    const { Tutorials } = cds.entities(AS);
    const tutorialRows = await admin.run(SELECT.from(Tutorials).where({ slug: ISO_T }));
    expect(tutorialRows.length).toBe(1);
    expect(tutorialRows[0].isolated).toBe(true);
  }, 120000);
});
