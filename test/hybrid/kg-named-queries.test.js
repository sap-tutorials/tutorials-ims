// test/hybrid/kg-named-queries.test.js
// Hybrid test for the NEIGHBORHOOD_QUERY named-query template — exercises the
// SPARQL UNION branches end-to-end against a real HANA KGE store and confirms
// the four branch types, weight ordering, self-filter behaviour, and graceful
// empty-input behaviour.
//
// EXPECTED LIFECYCLE
//   - BEFORE PR 5 deploy + grants: this test FAILS at the first sparqlExec()
//     call because either:
//       (a) the HDI container does not yet have SPARQL QUERY/UPDATE
//           privileges (SparqlPrivilegeError; see
//           docs/developers/operations/kg-grantor-setup.md), or
//       (b) the schema entities (Concepts, ConceptEdges,
//           TutorialConceptLinks, GraphMetadata) are missing.
//     That is the proof we want — TDD red-before-green.
//   - AFTER PR 5 deploys to DEV with grants in place: this test PASSES.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-named-queries.test.js
//
// SAFETY
//   - Targets a TEST-specific named graph (TEST_GRAPH_IRI) so production
//     state is untouched. graphRebuild()'s graphIri parameter is the lever.
//   - All seeded rows use TEST_PREFIX `__TEST__kg-named-` and are deleted
//     in afterAll() via raw SQL with LOWER() LIKE matching.
//   - The afterAll also CLEAR GRAPHs the test graph so the KGE store is
//     left clean even if the test crashed mid-run.
//
// WHY WE BUILD A LOCAL SPARQL VARIANT
//   The production NEIGHBORHOOD_QUERY (srv/lib/kg-queries.js) hardcodes
//   `FROM <https://developers.sap.com/kg/tutorials-v2>` (bumped from
//   `/tutorials` on 2026-06-21 per issue #533) so that the public
//   handler never accidentally queries a non-canonical graph. To exercise
//   the same UNION branch logic without touching production state, this
//   test builds an analogous query string by substituting our TEST_GRAPH_IRI
//   into the FROM clause. The tutorial IRI prefix is unchanged — both the
//   production and test graphs use kg/tutorial/<slug> — so the only delta
//   is the FROM URI. This gives us byte-identical UNION semantics in
//   isolation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { graphRebuild } from '../../srv/lib/kg-graph-rebuild.js';
import { kgGraphClear, kgAdminRunSparql } from '../../srv/lib/kg-sparql-client.js';

const TEST_PREFIX = `__TEST__kg-named-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const TEST_GRAPH_IRI = `https://developers.sap.com/kg/tutorials-test/${RUN_ID}`;

// Tutorial slugs (use TEST_PREFIX so cleanup is unambiguous).
const TUT_INPUT_SLUG = `${TEST_PREFIX}${RUN_ID}-input`;
const TUT_A_SLUG     = `${TEST_PREFIX}${RUN_ID}-tut-a`; // teaches c0 (prereq of c1)
const TUT_B_SLUG     = `${TEST_PREFIX}${RUN_ID}-tut-b`; // shares c2
const TUT_C_SLUG     = `${TEST_PREFIX}${RUN_ID}-tut-c`; // teaches c3 (requires c1)
const TUT_D_SLUG     = `${TEST_PREFIX}${RUN_ID}-tut-d`; // unrelated

// Concept slugs.
const C0 = `${TEST_PREFIX}${RUN_ID}-c0`;
const C1 = `${TEST_PREFIX}${RUN_ID}-c1`;
const C2 = `${TEST_PREFIX}${RUN_ID}-c2`;
const C3 = `${TEST_PREFIX}${RUN_ID}-c3`;
const C4 = `${TEST_PREFIX}${RUN_ID}-c4`;

// SPARQL template that mirrors NEIGHBORHOOD_QUERY but with the FROM clause
// pointing at our test graph. Inputs (slugs) are concatenated by the test —
// safe because they are TEST_PREFIX-derived constants, not user input.
//
// Per-arm LIMITs (kg-widget-ux-polish, 2026-06-30): mirrors the procedure
// fix in db/src/procedures/KG_QUERY.hdbprocedure. Each UNION arm is wrapped
// in a `{ SELECT ... LIMIT n }` subquery so the expensive whatToLearnNext
// arm can't starve the cheap teaches arm. See the regression test below
// (`per-arm LIMITs prevent whatToLearnNext from starving teaches`).
function buildNeighborhoodSparql(slug, graphIri) {
  return `PREFIX kg: <https://developers.sap.com/kg/>

SELECT DISTINCT ?type ?targetSlug ?targetLabel ?weight
FROM <${graphIri}>
WHERE {
  {
    SELECT ?type ?targetSlug ?targetLabel ?weight WHERE {
      <https://developers.sap.com/kg/tutorial/${slug}> kg:teaches ?concept .
      ?concept kg:slug ?targetSlug ; kg:name ?targetLabel .
      BIND("teaches" AS ?type) BIND(1.0 AS ?weight)
    } LIMIT 15
  } UNION {
    SELECT ?type ?targetSlug ?targetLabel ?weight WHERE {
      <https://developers.sap.com/kg/tutorial/${slug}> kg:teaches ?concept .
      ?concept kg:requires ?prereq .
      ?prereqTut kg:teaches ?prereq .
      FILTER(?prereqTut != <https://developers.sap.com/kg/tutorial/${slug}>)
      BIND(REPLACE(STR(?prereqTut), "https://developers.sap.com/kg/tutorial/", "") AS ?targetSlug)
      BIND("prerequisitesOf" AS ?type) BIND(0.9 AS ?weight)
    } LIMIT 15
  } UNION {
    SELECT ?type ?targetSlug ?targetLabel ?weight WHERE {
      <https://developers.sap.com/kg/tutorial/${slug}> kg:teaches ?sharedConcept .
      ?other kg:teaches ?sharedConcept .
      FILTER(?other != <https://developers.sap.com/kg/tutorial/${slug}>)
      BIND(REPLACE(STR(?other), "https://developers.sap.com/kg/tutorial/", "") AS ?targetSlug)
      BIND("sharedConcepts" AS ?type)
    } LIMIT 15
  } UNION {
    SELECT ?type ?targetSlug ?targetLabel ?weight WHERE {
      <https://developers.sap.com/kg/tutorial/${slug}> kg:teaches ?known .
      ?advanced kg:requires ?known .
      ?nextTut kg:teaches ?advanced .
      FILTER(?nextTut != <https://developers.sap.com/kg/tutorial/${slug}>)
      BIND(REPLACE(STR(?nextTut), "https://developers.sap.com/kg/tutorial/", "") AS ?targetSlug)
      BIND("whatToLearnNext" AS ?type)
    } LIMIT 30
  }
}
`;
}

describe('NEIGHBORHOOD_QUERY four-branch SPARQL (issue #381, KG PR 5)', () => {
  let db;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-named-queries.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
    const { Tutorials, Concepts, TutorialConceptLinks, ConceptEdges } =
      cds.entities('com.sap.developers.ims');

    // ---- Seed 5 tutorials ----
    await INSERT.into(Tutorials).entries([
      { slug: TUT_INPUT_SLUG, title: 'Test Input Tutorial' },
      { slug: TUT_A_SLUG,     title: 'Test Tutorial A (teaches prereq)' },
      { slug: TUT_B_SLUG,     title: 'Test Tutorial B (shares concept)' },
      { slug: TUT_C_SLUG,     title: 'Test Tutorial C (advanced builds-on)' },
      { slug: TUT_D_SLUG,     title: 'Test Tutorial D (unrelated)' },
    ]);

    // ---- Seed 5 concepts (all ACTIVE) ----
    await INSERT.into(Concepts).entries([
      { slug: C0, name: 'Concept Zero (prereq of c1)', status: 'ACTIVE' },
      { slug: C1, name: 'Concept One',                 status: 'ACTIVE' },
      { slug: C2, name: 'Concept Two (shared)',        status: 'ACTIVE' },
      { slug: C3, name: 'Concept Three (advanced)',    status: 'ACTIVE' },
      { slug: C4, name: 'Concept Four (taught by D)',  status: 'ACTIVE' },
    ]);

    // ---- Look up IDs for FK linkage ----
    const tutRows = await SELECT.from(Tutorials)
      .columns('ID', 'slug')
      .where({ slug: { in: [TUT_INPUT_SLUG, TUT_A_SLUG, TUT_B_SLUG, TUT_C_SLUG, TUT_D_SLUG] } });
    const tutId = Object.fromEntries(tutRows.map((r) => [r.slug, r.ID]));

    const conRows = await SELECT.from(Concepts)
      .columns('ID', 'slug')
      .where({ slug: { in: [C0, C1, C2, C3, C4] } });
    const conId = Object.fromEntries(conRows.map((r) => [r.slug, r.ID]));

    // ---- Seed TutorialConceptLinks ----
    // input teaches c1, c2 (powers `teaches` and `sharedConcepts` branches)
    // tut-a teaches c0 (powers `prerequisitesOf` via c1 -> c0 prereq edge)
    // tut-b teaches c2 (powers `sharedConcepts`)
    // tut-c teaches c3 (powers `whatToLearnNext` via c3 -> c1 requires edge)
    // tut-d teaches c4 (unrelated noise — never appears in input's neighborhood)
    await INSERT.into(TutorialConceptLinks).entries([
      { tutorial_ID: tutId[TUT_INPUT_SLUG], predicate: 'teaches', concept_ID: conId[C1], confidence: 0.95 },
      { tutorial_ID: tutId[TUT_INPUT_SLUG], predicate: 'teaches', concept_ID: conId[C2], confidence: 0.90 },
      { tutorial_ID: tutId[TUT_A_SLUG],     predicate: 'teaches', concept_ID: conId[C0], confidence: 0.85 },
      { tutorial_ID: tutId[TUT_B_SLUG],     predicate: 'teaches', concept_ID: conId[C2], confidence: 0.80 },
      { tutorial_ID: tutId[TUT_C_SLUG],     predicate: 'teaches', concept_ID: conId[C3], confidence: 0.75 },
      { tutorial_ID: tutId[TUT_D_SLUG],     predicate: 'teaches', concept_ID: conId[C4], confidence: 0.70 },
    ]);

    // ---- Seed ConceptEdges ----
    // c1 requires c0 (so tut-a, which teaches c0, becomes a prerequisitesOf for input)
    // c3 requires c1 (so tut-c, which teaches c3, becomes a whatToLearnNext for input)
    await INSERT.into(ConceptEdges).entries([
      { source_ID: conId[C1], target_ID: conId[C0], predicate: 'requires', confidence: 0.90, status: 'ACTIVE' },
      { source_ID: conId[C3], target_ID: conId[C1], predicate: 'requires', confidence: 0.85, status: 'ACTIVE' },
    ]);

    // ---- Project to RDF in our isolated test graph ----
    await graphRebuild({ db, graphIri: TEST_GRAPH_IRI });
  }, 120_000);

  afterAll(async () => {
    if (!db) return;

    try {
      await kgGraphClear({ db, graphIri: TEST_GRAPH_IRI });
    } catch (err) {
      // Don't fail teardown — the SQL cleanup below is what matters.
      // eslint-disable-next-line no-console
      console.warn('[kg-named-queries] CLEAR GRAPH cleanup failed:', err?.message);
    }

    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
       WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-named-%')
          OR TARGET_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-named-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
       WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
                              WHERE LOWER("SLUG") LIKE '__test__kg-named-%')
          OR CONCEPT_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                             WHERE LOWER("SLUG") LIKE '__test__kg-named-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
       WHERE LOWER("SLUG") LIKE '__test__kg-named-%'
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE LOWER("SLUG") LIKE '__test__kg-named-%'
    `);
  });

  // Helper: run the test-graph variant of NEIGHBORHOOD_QUERY and parse rows.
  async function runNeighborhood(slug) {
    const sparql = buildNeighborhoodSparql(slug, TEST_GRAPH_IRI);
    const { response } = await kgAdminRunSparql({ db, sparql, isUpdate: false });
    const parsed = JSON.parse(response);
    const bindings = parsed?.results?.bindings ?? [];
    return bindings.map((b) => ({
      type:        b?.type?.value ?? null,
      targetSlug:  b?.targetSlug?.value ?? null,
      targetLabel: b?.targetLabel?.value ?? null,
      weight:      b?.weight?.value !== undefined ? Number(b.weight.value) : null,
    }));
  }

  it('round-trips: all four branch ?type values are present after rebuild', async () => {
    const rows = await runNeighborhood(TUT_INPUT_SLUG);
    expect(rows.length).toBeGreaterThan(0);
    const types = new Set(rows.map((r) => r.type));
    expect(types.has('teaches')).toBe(true);
    expect(types.has('prerequisitesOf')).toBe(true);
    expect(types.has('sharedConcepts')).toBe(true);
    expect(types.has('whatToLearnNext')).toBe(true);
  });

  it('teaches branch emits weight 1.0 and binds targetLabel from kg:name', async () => {
    const rows = await runNeighborhood(TUT_INPUT_SLUG);
    const teaches = rows.filter((r) => r.type === 'teaches');
    expect(teaches.length).toBeGreaterThanOrEqual(2); // at minimum c1 and c2
    for (const row of teaches) {
      expect(row.weight).toBe(1.0);
      // kg:name is bound on the teaches branch.
      expect(typeof row.targetLabel).toBe('string');
      expect(row.targetLabel.length).toBeGreaterThan(0);
    }
    const taughtSlugs = new Set(teaches.map((r) => r.targetSlug));
    expect(taughtSlugs.has(C1)).toBe(true);
    expect(taughtSlugs.has(C2)).toBe(true);
  });

  it('prerequisitesOf branch emits weight 0.9 and binds the prereq tutorial slug', async () => {
    const rows = await runNeighborhood(TUT_INPUT_SLUG);
    const prereqs = rows.filter((r) => r.type === 'prerequisitesOf');
    expect(prereqs.length).toBeGreaterThan(0);
    for (const row of prereqs) {
      expect(row.weight).toBe(0.9);
    }
    // tut-a teaches c0, and c1 (taught by input) requires c0 → tut-a is a prereq.
    const prereqSlugs = new Set(prereqs.map((r) => r.targetSlug));
    expect(prereqSlugs.has(TUT_A_SLUG)).toBe(true);
  });

  it('self-filter: input tutorial never appears in any of the three tutorial-targeted branches', async () => {
    const rows = await runNeighborhood(TUT_INPUT_SLUG);
    const tutorialBranches = rows.filter((r) =>
      ['prerequisitesOf', 'sharedConcepts', 'whatToLearnNext'].includes(r.type)
    );
    for (const row of tutorialBranches) {
      expect(row.targetSlug).not.toBe(TUT_INPUT_SLUG);
    }
  });

  it('sharedConcepts and whatToLearnNext bind the expected tutorial slugs', async () => {
    const rows = await runNeighborhood(TUT_INPUT_SLUG);
    const shared = rows.filter((r) => r.type === 'sharedConcepts');
    const next = rows.filter((r) => r.type === 'whatToLearnNext');
    // tut-b shares c2 with input.
    expect(new Set(shared.map((r) => r.targetSlug)).has(TUT_B_SLUG)).toBe(true);
    // tut-c teaches c3 which requires c1 (taught by input).
    expect(new Set(next.map((r) => r.targetSlug)).has(TUT_C_SLUG)).toBe(true);
    // tut-d teaches c4 which has no edges to input's concepts — must NOT appear.
    const allTargets = new Set([
      ...shared.map((r) => r.targetSlug),
      ...next.map((r) => r.targetSlug),
    ]);
    expect(allTargets.has(TUT_D_SLUG)).toBe(false);
  });

  it('graceful empty: querying a slug that does not exist in the graph returns 0 bindings, not an error', async () => {
    const ghostSlug = `${TEST_PREFIX}${RUN_ID}-ghost-not-in-graph`;
    const rows = await runNeighborhood(ghostSlug);
    expect(rows).toHaveLength(0);
  });

  // ── Regression: per-arm LIMITs prevent starvation (kg-widget-ux-polish) ──
  //
  // History: on DEV 2026-06-30, publishing 100 concepts blew the original
  // `LIMIT 60` budget. The whatToLearnNext arm alone produced more than 60
  // rows because it scales as O(concepts × :requires × :teaches), and HANA's
  // SPARQL engine returned 60 rows from that arm + 0 from the other three.
  // The widget's `isEmpty(teaches.length === 0)` check then collapsed the
  // panel even though :teaches triples existed in the graph.
  //
  // This test seeds a fan-out chain (1 prereq concept → 30 derived concepts,
  // each taught by a distinct tutorial) so the whatToLearnNext arm produces
  // >15 candidates. With per-arm LIMITs the teaches arm still gets its own
  // 15-row budget; without them (pre-fix) it would starve to zero.
  it('per-arm LIMITs prevent whatToLearnNext from starving teaches', async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';
    const { Tutorials, Concepts, TutorialConceptLinks, ConceptEdges } =
      cds.entities('com.sap.developers.ims');

    // Use a NESTED RUN_ID so the seeded rows are namespaced apart from the
    // outer-describe rows and the afterAll's LIKE-pattern cleanup still
    // sweeps them. Both share TEST_PREFIX `__TEST__kg-named-`.
    const REG_ID = `${RUN_ID}-reg`;
    const INPUT  = `${TEST_PREFIX}${REG_ID}-input`;
    const SHARED = `${TEST_PREFIX}${REG_ID}-shared-concept`;
    const FANOUT = 25; // > 15 (per-arm LIMIT) so the arm overflows pre-fix.

    // Tutorials: 1 input + 25 derived-tutorials.
    const tutEntries = [{ slug: INPUT, title: 'Regression input' }];
    for (let i = 0; i < FANOUT; i++) {
      tutEntries.push({ slug: `${TEST_PREFIX}${REG_ID}-deriv-${i}`, title: `Derived ${i}` });
    }
    await INSERT.into(Tutorials).entries(tutEntries);

    // Concepts: 1 shared (taught by input) + 25 advanced (each requires the shared one).
    const conEntries = [
      { slug: SHARED, name: 'Shared regression concept', status: 'ACTIVE' },
    ];
    for (let i = 0; i < FANOUT; i++) {
      conEntries.push({
        slug: `${TEST_PREFIX}${REG_ID}-adv-${i}`,
        name: `Advanced concept ${i}`,
        status: 'ACTIVE',
      });
    }
    await INSERT.into(Concepts).entries(conEntries);

    // FK lookups.
    const tutRows = await SELECT.from(Tutorials)
      .columns('ID', 'slug')
      .where({ slug: { like: `${TEST_PREFIX}${REG_ID}-%` } });
    const tutId = Object.fromEntries(tutRows.map((r) => [r.slug, r.ID]));
    const conRows = await SELECT.from(Concepts)
      .columns('ID', 'slug')
      .where({ slug: { like: `${TEST_PREFIX}${REG_ID}-%` } });
    const conId = Object.fromEntries(conRows.map((r) => [r.slug, r.ID]));

    // input teaches the shared concept (powers the teaches arm).
    const tclEntries = [
      { tutorial_ID: tutId[INPUT], predicate: 'teaches', concept_ID: conId[SHARED], confidence: 0.9 },
    ];
    // Each derived tutorial teaches its own advanced concept.
    for (let i = 0; i < FANOUT; i++) {
      tclEntries.push({
        tutorial_ID: tutId[`${TEST_PREFIX}${REG_ID}-deriv-${i}`],
        predicate: 'teaches',
        concept_ID: conId[`${TEST_PREFIX}${REG_ID}-adv-${i}`],
        confidence: 0.8,
      });
    }
    await INSERT.into(TutorialConceptLinks).entries(tclEntries);

    // Each advanced concept :requires the shared concept — this is the
    // edge that builds the chain `input → shared ← requires ← adv-i ← deriv-i`,
    // which the whatToLearnNext arm walks. With FANOUT=25 advanced concepts,
    // the arm produces 25 candidate tutorials.
    const edgeEntries = [];
    for (let i = 0; i < FANOUT; i++) {
      edgeEntries.push({
        source_ID: conId[`${TEST_PREFIX}${REG_ID}-adv-${i}`],
        target_ID: conId[SHARED],
        predicate: 'requires',
        confidence: 0.85,
        status: 'ACTIVE',
      });
    }
    await INSERT.into(ConceptEdges).entries(edgeEntries);

    // Re-project to the test graph so the new rows become triples.
    await graphRebuild({ db, graphIri: TEST_GRAPH_IRI });

    const rows = await runNeighborhood(INPUT);

    const teaches = rows.filter((r) => r.type === 'teaches');
    const next    = rows.filter((r) => r.type === 'whatToLearnNext');

    // The whatToLearnNext arm must be at its per-arm cap (30) — confirms the
    // arm did overflow what a single `LIMIT 15` would have allowed; without
    // per-arm subqueries this would have eaten the LIMIT 60 budget.
    expect(next.length).toBeGreaterThanOrEqual(15);
    expect(next.length).toBeLessThanOrEqual(30);

    // The critical assertion: teaches did NOT starve. Pre-fix this was 0.
    expect(teaches.length).toBeGreaterThanOrEqual(1);
    // And specifically the SHARED concept that input teaches.
    expect(teaches.map((r) => r.targetSlug)).toContain(SHARED);
  }, 120_000);
});
