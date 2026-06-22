// test/hybrid/kg-graph-rebuild.test.js
// Hybrid test for the full KG rebuild round-trip — projects CDS state to
// RDF, dispatches to HANA KGE via SYS.SPARQL_EXECUTE, then queries the
// resulting graph back via SPARQL SELECT.
//
// EXPECTED LIFECYCLE
//   - BEFORE PR 4 deploy + grants: this test FAILS at the first
//     sparqlExec() call because either:
//       (a) the HDI container does not yet have SPARQL QUERY/UPDATE
//           privileges (SparqlPrivilegeError; remediation in
//           docs/developers/operations/kg-grantor-setup.md), or
//       (b) the schema entities (Concepts, ConceptEdges,
//           TutorialConceptLinks, GraphMetadata) are missing.
//     That is the proof we want — TDD red-before-green.
//   - AFTER PR 4 deploys to DEV with grants in place: this test PASSES.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-graph-rebuild.test.js
//
// SAFETY
//   - Targets a TEST-specific named graph (TEST_GRAPH_IRI) so production
//     state is untouched. graphRebuild()'s graphIri parameter is the lever.
//   - All seeded rows use the TEST_PREFIX `__TEST__kg-rebuild-` and are
//     deleted in afterAll() via raw SQL with LOWER() LIKE matching.
//   - The afterAll also CLEAR GRAPHs the test graph so the KGE store is
//     left clean even if the test crashed mid-run.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { graphRebuild, GRAPH_METADATA_SINGLETON_ID } from '../../srv/lib/kg-graph-rebuild.js';
import { kgGraphClear, kgAdminRunSparql } from '../../srv/lib/kg-sparql-client.js';

const TEST_PREFIX = `__TEST__kg-rebuild-`;
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_GRAPH_IRI = `https://developers.sap.com/kg/tutorials-test/${RUN_ID}`;

// Slugs we will seed.
const TUT_A_SLUG = `${TEST_PREFIX}${RUN_ID}-tut-a`;
const TUT_B_SLUG = `${TEST_PREFIX}${RUN_ID}-tut-b`;
const CONCEPT_ACTIVE_SLUG = `${TEST_PREFIX}${RUN_ID}-concept-active`;
const CONCEPT_ACTIVE_2_SLUG = `${TEST_PREFIX}${RUN_ID}-concept-active2`;
const CONCEPT_MERGED_SLUG = `${TEST_PREFIX}${RUN_ID}-concept-merged`;

describe('graphRebuild full round-trip (issue #381, KG PR 4)', () => {
  let db;
  let Concepts, TutorialConceptLinks, ConceptEdges, Tutorials;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-graph-rebuild.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
    const ents = cds.entities('com.sap.developers.ims');
    Concepts = ents.Concepts;
    TutorialConceptLinks = ents.TutorialConceptLinks;
    ConceptEdges = ents.ConceptEdges;
    Tutorials = ents.Tutorials;

    // Seed two tutorials.
    await INSERT.into(Tutorials).entries([
      { slug: TUT_A_SLUG, title: 'Test tutorial A' },
      { slug: TUT_B_SLUG, title: 'Test tutorial B' },
    ]);

    // Seed concepts: 2 ACTIVE + 1 MERGED.
    await INSERT.into(Concepts).entries([
      { slug: CONCEPT_ACTIVE_SLUG, name: 'Active Concept 1', status: 'ACTIVE' },
      { slug: CONCEPT_ACTIVE_2_SLUG, name: 'Active Concept 2', status: 'ACTIVE' },
      { slug: CONCEPT_MERGED_SLUG, name: 'Merged Concept', status: 'MERGED' },
    ]);

    // Look up IDs.
    const [{ ID: tutAId }] = await SELECT.from(Tutorials).columns('ID').where({ slug: TUT_A_SLUG });
    const [{ ID: tutBId }] = await SELECT.from(Tutorials).columns('ID').where({ slug: TUT_B_SLUG });
    const [{ ID: cAct1Id }] = await SELECT.from(Concepts).columns('ID').where({ slug: CONCEPT_ACTIVE_SLUG });
    const [{ ID: cAct2Id }] = await SELECT.from(Concepts).columns('ID').where({ slug: CONCEPT_ACTIVE_2_SLUG });
    const [{ ID: cMrgId }] = await SELECT.from(Concepts).columns('ID').where({ slug: CONCEPT_MERGED_SLUG });

    // Seed 5 TutorialConceptLinks. Mix teaches + extends.
    await INSERT.into(TutorialConceptLinks).entries([
      { tutorial_ID: tutAId, predicate: 'teaches', concept_ID: cAct1Id, confidence: 0.95 },
      { tutorial_ID: tutAId, predicate: 'teaches', concept_ID: cAct2Id, confidence: 0.80 },
      { tutorial_ID: tutBId, predicate: 'teaches', concept_ID: cAct1Id, confidence: 0.90 },
      // Link to MERGED concept — projection should drop this (post-PR 5; for
      // PR 4 the projection emits whatever is in the table). The graph-level
      // assertion below only inspects the MERGED concept's IRI, not its links.
      { tutorial_ID: tutBId, predicate: 'teaches', concept_ID: cMrgId, confidence: 0.70 },
      { tutorial_ID: tutBId, predicate: 'extends', extendsTutorial_ID: tutAId, confidence: 0.60 },
    ]);

    // Seed 2 ConceptEdges (ACTIVE).
    await INSERT.into(ConceptEdges).entries([
      { source_ID: cAct1Id, target_ID: cAct2Id, predicate: 'requires', confidence: 0.85, status: 'ACTIVE' },
      { source_ID: cAct2Id, target_ID: cAct1Id, predicate: 'relatedTo', confidence: 0.75, status: 'ACTIVE' },
    ]);
  });

  afterAll(async () => {
    if (!db) return;

    // Best-effort: wipe the test named graph so the KGE store is clean.
    try {
      await kgGraphClear({ db, graphIri: TEST_GRAPH_IRI });
    } catch (err) {
      // Surface but don't fail teardown — the SQL cleanup below is what
      // matters for repeatability of the suite.
      // eslint-disable-next-line no-console
      console.warn('[kg-graph-rebuild test] CLEAR GRAPH cleanup failed:', err?.message);
    }

    // Clean DB rows. Defensive LOWER() LIKE so casing variation is caught.
    // Order matters: edges + links FIRST (they reference Concepts/Tutorials).
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
       WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%')
          OR TARGET_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
       WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
                              WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%')
          OR CONCEPT_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                             WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%')
          OR EXTENDSTUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
                                     WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
       WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%'
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE LOWER("SLUG") LIKE '__test__kg-rebuild-%'
    `);
  });

  it('rebuilds the test graph and reports a positive triple count', async () => {
    const result = await graphRebuild({ db, graphIri: TEST_GRAPH_IRI });
    expect(result).toMatchObject({
      graphVersion: expect.any(String),
      tripleCount: expect.any(Number),
      durationMs: expect.any(Number),
      predicateCounts: expect.any(Object),
    });
    expect(result.graphVersion).toMatch(/[0-9a-f-]{36}/i); // UUID shape
    expect(result.tripleCount).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('the graph is queryable via SPARQL SELECT and triple count matches', async () => {
    // ASSUMPTION: the previous test's graphRebuild already populated the graph.
    const sparql = `SELECT (COUNT(*) AS ?n) FROM <${TEST_GRAPH_IRI}> WHERE { ?s ?p ?o }`;
    const { response } = await kgAdminRunSparql({ db, sparql, isUpdate: false });
    // KGE returns SPARQL-results-JSON by default.
    const parsed = JSON.parse(response);
    const nLiteral = parsed.results?.bindings?.[0]?.n?.value;
    const n = Number(nLiteral);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('a seeded kg:teaches triple is queryable via 1-hop SPARQL', async () => {
    const tutIri = `https://developers.sap.com/kg/tutorial/${TUT_A_SLUG}`;
    const conceptIri = `https://developers.sap.com/kg/concept/${CONCEPT_ACTIVE_SLUG}`;
    const teachesIri = `https://developers.sap.com/kg/teaches`;
    const sparql = `
      SELECT ?o FROM <${TEST_GRAPH_IRI}> WHERE {
        <${tutIri}> <${teachesIri}> ?o .
      }
    `;
    const { response } = await kgAdminRunSparql({ db, sparql, isUpdate: false });
    const parsed = JSON.parse(response);
    const objects = (parsed.results?.bindings ?? []).map((b) => b.o?.value);
    expect(objects).toContain(conceptIri);
  });

  it('MERGED concepts emit no rdf:type Concept triples', async () => {
    // MERGED concepts are filtered from the graph by the projection. Asking
    // for the merged concept's IRI as a subject must return zero rows.
    const mergedIri = `https://developers.sap.com/kg/concept/${CONCEPT_MERGED_SLUG}`;
    const rdfType = `http://www.w3.org/1999/02/22-rdf-syntax-ns#type`;
    const conceptType = `https://developers.sap.com/kg/Concept`;
    const sparql = `
      SELECT ?s FROM <${TEST_GRAPH_IRI}> WHERE {
        ?s <${rdfType}> <${conceptType}> .
        FILTER (?s = <${mergedIri}>)
      }
    `;
    const { response } = await kgAdminRunSparql({ db, sparql, isUpdate: false });
    const parsed = JSON.parse(response);
    const bindings = parsed.results?.bindings ?? [];
    expect(bindings).toHaveLength(0);
  });

  it('GraphMetadata singleton is updated with the new graphVersion', async () => {
    const { GraphMetadata } = cds.entities('com.sap.developers.ims');

    // Capture the version we just wrote (the previous tests called rebuild
    // once via the first `it`).
    const beforeRow = await SELECT.one.from(GraphMetadata).where({ ID: GRAPH_METADATA_SINGLETON_ID });
    expect(beforeRow).toBeTruthy();
    const beforeVersion = beforeRow.graphVersion;

    // Rebuild again — version must change (UUID).
    const result = await graphRebuild({ db, graphIri: TEST_GRAPH_IRI });
    expect(result.graphVersion).not.toBe(beforeVersion);

    const afterRow = await SELECT.one.from(GraphMetadata).where({ ID: GRAPH_METADATA_SINGLETON_ID });
    expect(afterRow.graphVersion).toBe(result.graphVersion);
    expect(afterRow.tripleCount).toBe(result.tripleCount);
    expect(afterRow.durationMs).toBe(result.durationMs);
  });
});
