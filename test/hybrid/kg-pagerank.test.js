// test/hybrid/kg-pagerank.test.js
//
// End-to-end hybrid test — seeds a small hub-and-spoke fixture in the LIVE
// DEV HDI, drives the runKgPageRank() job body, and verifies that:
//   1. The job returns non-zero counts.
//   2. Scores land in the ConceptRank / TutorialRank sidecar tables.
//   3. The fixture's hub concept scores higher than its leaves.
//
// SAFETY
//   - All fixtures use TEST_PREFIX `__TEST__kg-pagerank-`. The afterAll
//     cleans up via LOWER(slug) LIKE. Gated by ALLOW_HYBRID_WRITES via
//     ./_guard.js::isSafeForWrites().
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-pagerank.test.js
//
// SCOPE
//   runKgPageRank() computes PageRank over the WHOLE workspace (17k+
//   vertices), not just the fixture. Assertions filter the sidecar
//   tables by LOWER(slug) LIKE '__test__kg-pagerank-%' so only the
//   fixture rows are checked. This is intentional — the job's atomic
//   TRUNCATE-then-INSERT is exercised against the real DB shape.
//
// FIXTURE
//   Two-layer hub-and-spoke:
//     hub-concept ── leaf-c1
//                 ── leaf-c2
//                 ── leaf-c3      (via ConceptEdges `requires`)
//     hub-tutorial teaches hub-concept
//     spoke-t{1,2,3} each teach one leaf-c{1,2,3}
//   Under undirected PageRank, hub-concept dominates the concept tier;
//   spoke tutorials tie by symmetry. See the unit test at
//   test/unit/kg-pagerank-compute.test.js for the closed-form analysis.
//
// Spec:  docs/superpowers/specs/2026-07-04-916-kg-pagerank-design.md
// Issue: #916 (prereq #919 merged 2026-07-04, PR #974)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { runKgPageRank } from '../../srv/jobs/kg-pagerank-job.js';

const TEST_PREFIX = `__test__kg-pagerank-`;   // lowercase — matches slug canonicalization
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const HUB_C   = `${TEST_PREFIX}${RUN_ID}-hub-c`;
const LEAF_1  = `${TEST_PREFIX}${RUN_ID}-leaf-c1`;
const LEAF_2  = `${TEST_PREFIX}${RUN_ID}-leaf-c2`;
const LEAF_3  = `${TEST_PREFIX}${RUN_ID}-leaf-c3`;
const HUB_T   = `${TEST_PREFIX}${RUN_ID}-hub-t`;
const SPOKE_1 = `${TEST_PREFIX}${RUN_ID}-spoke-t1`;
const SPOKE_2 = `${TEST_PREFIX}${RUN_ID}-spoke-t2`;
const SPOKE_3 = `${TEST_PREFIX}${RUN_ID}-spoke-t3`;

const CONCEPT_SLUGS  = [HUB_C, LEAF_1, LEAF_2, LEAF_3];
const TUTORIAL_SLUGS = [HUB_T, SPOKE_1, SPOKE_2, SPOKE_3];

describe('KG_PAGERANK end-to-end (issue #916)', () => {
  let db;

  beforeAll(async () => {
    if (!isSafeForWrites()) {
      throw new Error(
        'kg-pagerank.test.js: write-safety guard rejected — refusing to seed. ' +
        'Ensure ALLOW_HYBRID_WRITES=true and CF target is a non-prod space.',
      );
    }
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        `kg-pagerank.test.js: expected HANA binding, got ${db.constructor?.name}. ` +
        'Run with `cds bind --exec --profile hybrid`.',
      );
    }

    const { Concepts, ConceptEdges, Tutorials, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Seed concepts (all ACTIVE — required so KG_PG_VERTICES_V includes them).
    await INSERT.into(Concepts).entries([
      { slug: HUB_C,  name: `Hub ${HUB_C}`,   status: 'ACTIVE' },
      { slug: LEAF_1, name: `Leaf ${LEAF_1}`, status: 'ACTIVE' },
      { slug: LEAF_2, name: `Leaf ${LEAF_2}`, status: 'ACTIVE' },
      { slug: LEAF_3, name: `Leaf ${LEAF_3}`, status: 'ACTIVE' },
    ]);

    // Seed tutorials.
    await INSERT.into(Tutorials).entries([
      { slug: HUB_T,   title: `Hub ${HUB_T}` },
      { slug: SPOKE_1, title: `Spoke ${SPOKE_1}` },
      { slug: SPOKE_2, title: `Spoke ${SPOKE_2}` },
      { slug: SPOKE_3, title: `Spoke ${SPOKE_3}` },
    ]);

    // Look up IDs for FK linkage.
    const conRows = await SELECT.from(Concepts)
      .columns('ID', 'slug')
      .where({ slug: { in: CONCEPT_SLUGS } });
    const conId = Object.fromEntries(conRows.map((r) => [r.slug, r.ID]));

    const tutRows = await SELECT.from(Tutorials)
      .columns('ID', 'slug')
      .where({ slug: { in: TUTORIAL_SLUGS } });
    const tutId = Object.fromEntries(tutRows.map((r) => [r.slug, r.ID]));

    // 3 ConceptEdges: each leaf REQUIRES the hub.
    await INSERT.into(ConceptEdges).entries([
      { source_ID: conId[LEAF_1], target_ID: conId[HUB_C], predicate: 'requires', status: 'ACTIVE', confidence: 0.9 },
      { source_ID: conId[LEAF_2], target_ID: conId[HUB_C], predicate: 'requires', status: 'ACTIVE', confidence: 0.9 },
      { source_ID: conId[LEAF_3], target_ID: conId[HUB_C], predicate: 'requires', status: 'ACTIVE', confidence: 0.9 },
    ]);

    // 4 TutorialConceptLinks: each tutorial teaches one concept.
    await INSERT.into(TutorialConceptLinks).entries([
      { tutorial_ID: tutId[HUB_T],   concept_ID: conId[HUB_C],  predicate: 'teaches', confidence: 0.9 },
      { tutorial_ID: tutId[SPOKE_1], concept_ID: conId[LEAF_1], predicate: 'teaches', confidence: 0.9 },
      { tutorial_ID: tutId[SPOKE_2], concept_ID: conId[LEAF_2], predicate: 'teaches', confidence: 0.9 },
      { tutorial_ID: tutId[SPOKE_3], concept_ID: conId[LEAF_3], predicate: 'teaches', confidence: 0.9 },
    ]);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;

    // FK-safe delete order: links → edges → tutorials → concepts.
    // Sidecar rank tables have no FK; clean their fixture rows last.
    // Uppercase table + column names, LOWER() the slug for case-insensitive
    // match — mirrors kg-path-v2.test.js.
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
       WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
                              WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%')
          OR CONCEPT_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                             WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
       WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%')
          OR TARGET_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%'
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
       WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%'
    `);

    // Rank tables (sidecars) — clean fixture rows so the next test run
    // starts clean. Not strictly needed (next runKgPageRank TRUNCATEs
    // everything anyway) but keeps the DB tidy between runs.
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"
       WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%'
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"
       WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%'
    `);
  }, 60_000);

  it('runKgPageRank populates ConceptRank + TutorialRank with the fixture slugs', async () => {
    const summary = await runKgPageRank();

    // Sanity on the return summary — non-zero scored counts, converged
    // in a reasonable number of iterations, timing fields present.
    expect(summary.conceptsScored).toBeGreaterThan(4);          // whole workspace, not just fixture
    expect(summary.tutorialsScored).toBeGreaterThan(4);
    expect(summary.iterations).toBeGreaterThan(0);
    expect(summary.iterations).toBeLessThanOrEqual(100);
    expect(Number.isFinite(summary.durationMs)).toBe(true);

    // Fetch the fixture-only rows out of the sidecar tables.
    const conceptRows = await db.run(`
      SELECT "SLUG", "SCORE" FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"
       WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%'
    `);
    const tutorialRows = await db.run(`
      SELECT "SLUG", "SCORE" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"
       WHERE LOWER("SLUG") LIKE '__test__kg-pagerank-%'
    `);

    expect(conceptRows.length).toBe(4);
    expect(tutorialRows.length).toBe(4);

    // Every fixture score is a finite positive number in (0, 1).
    for (const r of [...conceptRows, ...tutorialRows]) {
      expect(Number.isFinite(r.SCORE)).toBe(true);
      expect(r.SCORE).toBeGreaterThan(0);
      expect(r.SCORE).toBeLessThan(1);
    }

    // Concept tier ordering: hub outranks each leaf.
    const cScore = Object.fromEntries(conceptRows.map(r => [r.SLUG, r.SCORE]));
    expect(cScore[HUB_C]).toBeGreaterThan(cScore[LEAF_1]);
    expect(cScore[HUB_C]).toBeGreaterThan(cScore[LEAF_2]);
    expect(cScore[HUB_C]).toBeGreaterThan(cScore[LEAF_3]);

    // Leaf concepts are symmetric — same score to ~4 decimals. Wider
    // tolerance than the pure unit test (unit uses toBeCloseTo(6)) because
    // the fixture lives inside the full 17k-vertex workspace and picks
    // up trace rank contributions from any pre-existing edges that
    // happen to bridge to a concept slug that starts with '__test__'.
    // In practice those are zero, but the wider tolerance is defensive.
    expect(cScore[LEAF_1]).toBeCloseTo(cScore[LEAF_2], 4);
    expect(cScore[LEAF_2]).toBeCloseTo(cScore[LEAF_3], 4);

    // Tutorial tier: three spoke tutorials tie by symmetry.
    const tScore = Object.fromEntries(tutorialRows.map(r => [r.SLUG, r.SCORE]));
    expect(tScore[SPOKE_1]).toBeCloseTo(tScore[SPOKE_2], 4);
    expect(tScore[SPOKE_2]).toBeCloseTo(tScore[SPOKE_3], 4);
  }, 120_000);
});
