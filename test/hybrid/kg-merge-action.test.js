// test/hybrid/kg-merge-action.test.js
// Hybrid test for the per-pair concept merge primitive (srv/lib/kg-merge-pair.js)
// — exercises the FK-redirect + composite-PK collision avoidance against real
// HANA. Both the cron consolidator and the admin `mergeConcepts` action call
// `mergeConceptPair` with byte-identical semantics, so this test covers both
// code paths.
//
// EXPECTED LIFECYCLE
//   - BEFORE PR 5 deploy: this test FAILS at the first INSERT because the
//     schema entities or @assert.unique constraints are missing.
//   - AFTER PR 5 deploys to DEV: this test PASSES.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-merge-action.test.js
//
// SAFETY
//   - All seeded rows use TEST_PREFIX `__TEST__kg-merge-` and are deleted
//     in afterAll() via raw SQL with LOWER() LIKE matching.
//   - No graph projection is performed — this test exclusively covers the
//     CDS-level merge primitive; the SPARQL graph is untouched by the
//     primitive itself (graph rebuild is fired-and-forgot by the admin
//     handler, which is out of scope here).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { mergeConceptPair } from '../../srv/lib/kg-merge-pair.js';

const TEST_PREFIX = `__TEST__kg-merge-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Concept slugs.
const CANONICAL_SLUG = `${TEST_PREFIX}${RUN_ID}-canonical`;
const LOSER_SLUG     = `${TEST_PREFIX}${RUN_ID}-loser`;
const THIRD_SLUG     = `${TEST_PREFIX}${RUN_ID}-third`;
const FOURTH_SLUG    = `${TEST_PREFIX}${RUN_ID}-fourth`;

// Tutorial slugs (six total: enough to seed the 5 links + 1 collision row).
const TUT_SLUGS = Array.from({ length: 6 }, (_, i) => `${TEST_PREFIX}${RUN_ID}-tut-${i + 1}`);

describe('mergeConceptPair primitive (issue #381, KG PR 5)', () => {
  let db;
  let canonicalId, loserId, thirdId, fourthId;
  let tutIds;
  let log;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-merge-action.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
    log = cds.log('kg-merge-action-test');

    const { Tutorials, Concepts, TutorialConceptLinks, ConceptEdges } =
      cds.entities('com.sap.developers.ims');

    // ---- Seed 6 tutorials ----
    await INSERT.into(Tutorials).entries(
      TUT_SLUGS.map((slug, i) => ({ slug, title: `Test Tutorial ${i + 1}` }))
    );
    const tutRows = await SELECT.from(Tutorials)
      .columns('ID', 'slug')
      .where({ slug: { in: TUT_SLUGS } });
    tutIds = Object.fromEntries(tutRows.map((r) => [r.slug, r.ID]));

    // ---- Seed 4 concepts (all ACTIVE, canonical + loser share name to test tie-break) ----
    await INSERT.into(Concepts).entries([
      { slug: CANONICAL_SLUG, name: 'Shared Concept Name', status: 'ACTIVE' },
      { slug: LOSER_SLUG,     name: 'Shared Concept Name', status: 'ACTIVE' },
      { slug: THIRD_SLUG,     name: 'Third Concept',       status: 'ACTIVE' },
      { slug: FOURTH_SLUG,    name: 'Fourth Concept',      status: 'ACTIVE' },
    ]);
    const conRows = await SELECT.from(Concepts)
      .columns('ID', 'slug')
      .where({ slug: { in: [CANONICAL_SLUG, LOSER_SLUG, THIRD_SLUG, FOURTH_SLUG] } });
    const conId = Object.fromEntries(conRows.map((r) => [r.slug, r.ID]));
    canonicalId = conId[CANONICAL_SLUG];
    loserId     = conId[LOSER_SLUG];
    thirdId     = conId[THIRD_SLUG];
    fourthId    = conId[FOURTH_SLUG];

    // ---- Seed 5 TutorialConceptLinks ----
    // 3 point at canonical (tut-1, tut-2, tut-3).
    // 2 point at loser    (tut-4, tut-5).
    // All `predicate='teaches'`. After merge: all 5 must point at canonical
    // and the unique-constraint must NOT be violated.
    await INSERT.into(TutorialConceptLinks).entries([
      { tutorial_ID: tutIds[TUT_SLUGS[0]], predicate: 'teaches', concept_ID: canonicalId, confidence: 0.95 },
      { tutorial_ID: tutIds[TUT_SLUGS[1]], predicate: 'teaches', concept_ID: canonicalId, confidence: 0.90 },
      { tutorial_ID: tutIds[TUT_SLUGS[2]], predicate: 'teaches', concept_ID: canonicalId, confidence: 0.85 },
      { tutorial_ID: tutIds[TUT_SLUGS[3]], predicate: 'teaches', concept_ID: loserId,     confidence: 0.80 },
      { tutorial_ID: tutIds[TUT_SLUGS[4]], predicate: 'teaches', concept_ID: loserId,     confidence: 0.75 },
    ]);

    // ---- Seed 2 ConceptEdges to exercise source-redirect + target-redirect ----
    // loser requires third  (source-redirect path)
    // fourth requires loser (target-redirect path)
    await INSERT.into(ConceptEdges).entries([
      { source_ID: loserId,  target_ID: thirdId, predicate: 'requires', confidence: 0.85, status: 'ACTIVE' },
      { source_ID: fourthId, target_ID: loserId, predicate: 'requires', confidence: 0.80, status: 'ACTIVE' },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    // Edges and links FIRST (they reference Concepts/Tutorials).
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
       WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-merge-%')
          OR TARGET_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-merge-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
       WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
                              WHERE LOWER("SLUG") LIKE '__test__kg-merge-%')
          OR CONCEPT_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                             WHERE LOWER("SLUG") LIKE '__test__kg-merge-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
       WHERE LOWER("SLUG") LIKE '__test__kg-merge-%'
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE LOWER("SLUG") LIKE '__test__kg-merge-%'
    `);
  });

  it('returns the structured collateral-counts object', async () => {
    // First call exercises the full redirect path. linksDeleted/edgesDeleted
    // are 0 here because we haven't seeded any colliding rows yet.
    const result = await mergeConceptPair({ db, log, loserId, canonicalId });
    expect(result).toMatchObject({
      linksDeleted: expect.any(Number),
      edgesDeleted: expect.any(Number),
    });
  });

  it('post-merge: loser status is MERGED and mergedInto_ID points at canonical', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const loser = await SELECT.one
      .from(Concepts)
      .columns('ID', 'status', 'mergedInto_ID')
      .where({ ID: loserId });
    expect(loser.status).toBe('MERGED');
    expect(loser.mergedInto_ID).toBe(canonicalId);
  });

  it('post-merge: all 5 TutorialConceptLinks now point at canonical (no unique-constraint violations)', async () => {
    const { TutorialConceptLinks } = cds.entities('com.sap.developers.ims');

    // No links should remain pointing at the (MERGED) loser.
    const remainingLoserLinks = await SELECT.from(TutorialConceptLinks)
      .where({ concept_ID: loserId });
    expect(remainingLoserLinks).toHaveLength(0);

    // All five tutorials should now have a teaches→canonical link.
    const canonicalLinks = await SELECT.from(TutorialConceptLinks)
      .columns('tutorial_ID', 'predicate', 'concept_ID')
      .where({ concept_ID: canonicalId });
    const tutorialIds = canonicalLinks
      .filter((l) => l.predicate === 'teaches')
      .map((l) => l.tutorial_ID);
    // tut-1..tut-5 must all be present (tut-6 is reserved for the collision case below).
    for (let i = 0; i < 5; i++) {
      expect(tutorialIds).toContain(tutIds[TUT_SLUGS[i]]);
    }
  });

  it('post-merge: ConceptEdges are redirected (source + target), self-loops dropped', async () => {
    const { ConceptEdges } = cds.entities('com.sap.developers.ims');

    // No edge should reference loser as either endpoint.
    const danglingEdges = await SELECT.from(ConceptEdges)
      .where({
        or: [
          { source_ID: loserId },
          { target_ID: loserId },
        ],
      });
    expect(danglingEdges).toHaveLength(0);

    // Source-redirect: the original `loser requires third` edge now reads
    // `canonical requires third`.
    const srcEdge = await SELECT.from(ConceptEdges)
      .where({ source_ID: canonicalId, target_ID: thirdId, predicate: 'requires' });
    expect(srcEdge.length).toBeGreaterThanOrEqual(1);

    // Target-redirect: the original `fourth requires loser` edge now reads
    // `fourth requires canonical`.
    const tgtEdge = await SELECT.from(ConceptEdges)
      .where({ source_ID: fourthId, target_ID: canonicalId, predicate: 'requires' });
    expect(tgtEdge.length).toBeGreaterThanOrEqual(1);

    // Self-loops on canonical/canonical must NOT exist (none seeded here, but
    // the primitive's drop-self-loop step must not invent them either).
    const selfLoops = await SELECT.from(ConceptEdges)
      .where({ source_ID: canonicalId, target_ID: canonicalId });
    expect(selfLoops).toHaveLength(0);
  });

  it('idempotency: re-merging an already-MERGED loser is a safe no-op', async () => {
    // Call again with the same loser/canonical pair. The primitive must NOT
    // throw, the loser must remain MERGED, and the redirect set must remain
    // stable (links/edges already point at canonical from the first run).
    const result = await mergeConceptPair({ db, log, loserId, canonicalId });
    expect(result).toMatchObject({
      linksDeleted: expect.any(Number),
      edgesDeleted: expect.any(Number),
    });

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const loser = await SELECT.one
      .from(Concepts)
      .columns('status', 'mergedInto_ID')
      .where({ ID: loserId });
    expect(loser.status).toBe('MERGED');
    expect(loser.mergedInto_ID).toBe(canonicalId);
  });

  it('composite-PK collision: pre-detect-and-delete avoids @assert.unique violation', async () => {
    // Set up a fresh canonical/loser pair where the SAME tutorial holds both
    // (tut, canonical, teaches) AND (tut, loser, teaches). A naive UPDATE
    // would crash on @assert.unique.tutorialConcept; the primitive must
    // delete the loser-row first.
    const { Tutorials, Concepts, TutorialConceptLinks } = cds.entities('com.sap.developers.ims');

    const canonical2Slug = `${TEST_PREFIX}${RUN_ID}-canonical2`;
    const loser2Slug     = `${TEST_PREFIX}${RUN_ID}-loser2`;

    await INSERT.into(Concepts).entries([
      { slug: canonical2Slug, name: 'Collision canonical', status: 'ACTIVE' },
      { slug: loser2Slug,     name: 'Collision loser',     status: 'ACTIVE' },
    ]);
    const c2 = await SELECT.from(Concepts)
      .columns('ID', 'slug')
      .where({ slug: { in: [canonical2Slug, loser2Slug] } });
    const c2Id = Object.fromEntries(c2.map((r) => [r.slug, r.ID]));

    // Use TUT_SLUGS[5] (tut-6) — reserved for this collision case.
    const collisionTutId = tutIds[TUT_SLUGS[5]];

    // Seed BOTH the canonical-row and the loser-row for the same (tut, predicate).
    await INSERT.into(TutorialConceptLinks).entries([
      { tutorial_ID: collisionTutId, predicate: 'teaches', concept_ID: c2Id[canonical2Slug], confidence: 0.99 },
      { tutorial_ID: collisionTutId, predicate: 'teaches', concept_ID: c2Id[loser2Slug],     confidence: 0.50 },
    ]);

    // Merge — must NOT throw on the unique constraint.
    const result = await mergeConceptPair({
      db,
      log,
      loserId: c2Id[loser2Slug],
      canonicalId: c2Id[canonical2Slug],
    });
    expect(result.linksDeleted).toBeGreaterThanOrEqual(1);

    // After merge, only ONE link remains for (tut, teaches): the canonical row.
    const afterLinks = await SELECT.from(TutorialConceptLinks)
      .columns('concept_ID', 'confidence')
      .where({ tutorial_ID: collisionTutId, predicate: 'teaches' });
    expect(afterLinks).toHaveLength(1);
    expect(afterLinks[0].concept_ID).toBe(c2Id[canonical2Slug]);
    // Canonical's original confidence (0.99) is preserved — delete-loser, keep-canonical.
    expect(Number(afterLinks[0].confidence)).toBeCloseTo(0.99, 2);

    // Loser is still flagged MERGED (the redirect happened at the row level
    // even though we deleted instead of UPDATE'd the colliding pair).
    const loser2 = await SELECT.one
      .from(Concepts)
      .columns('status', 'mergedInto_ID')
      .where({ ID: c2Id[loser2Slug] });
    expect(loser2.status).toBe('MERGED');
    expect(loser2.mergedInto_ID).toBe(c2Id[canonical2Slug]);
  });
});
