// test/hybrid/kg-sparql-execute-json-contract.test.js
//
// Regression guard for issue #745 (motivated by PR #743's fix).
//
// THE BUG WE'RE GUARDING AGAINST
//   KG_QUERY.hdbprocedure called SYS_SPARQL_EXECUTE without an Accept
//   header, so HANA returned the SPARQL results as XML
//   (application/sparql-results+xml). Every JS caller's
//   JSON.parse(response) then threw, the per-query parser caught the
//   exception and returned [] (silent swallow), and the explore graph /
//   tutorial neighborhood UI rendered zero results.
//
//   The bug shipped because the existing test surfaces were either:
//     * unit tests that mock kgQuery() with a hand-written JSON string
//       (never exercise the live SPARQL_EXECUTE call), or
//     * hybrid tests on the JS layer that mock the SPARQL response
//       (test/hybrid/kg-named-queries.test.js, kg-graph-rebuild.test.js
//       et al), or
//     * kg-procedures-query.test.js — which DOES call KG_QUERY end-to-end,
//       but only asserts `response is defined` rather than
//       `response is JSON`, so an XML body would slip through.
//
//   PR #743 added 'Accept: application/sparql-results+json' to the
//   CALL SYS_SPARQL_EXECUTE in KG_QUERY.hdbprocedure. This test
//   exercises the full JS → DEFINER procedure → SPARQL engine path
//   against live HANA and asserts the response IS valid JSON with the
//   expected shape. If anyone strips the Accept header again, this
//   test fails loudly at the JSON-parse step.
//
// WHY EXPLORE_GRAPH_BULK
//   It's the query name that hit the bug in production (#743). It's
//   also the simplest query name to seed: no input params (the only
//   inputs are p1/p2/p3 which it ignores), and the SPARQL only filters
//   on a fixed set of 9 edge predicates — easy to satisfy with three
//   N-Triples on the canonical kg:teaches predicate.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- \
//     npx vitest run --project hybrid \
//     test/hybrid/kg-sparql-execute-json-contract.test.js
//
//   The ALLOW_HYBRID_WRITES gate is required because we seed a test
//   graph via KG_GRAPH_INSERT. Other hybrid tests in the kg-* family
//   already require this flag.
//
// SAFETY
//   - Per-run unique TEST_GRAPH IRI scoped to this fixture so parallel
//     CI runs do not collide and the production graph is untouched.
//   - Seeding uses KG_GRAPH_INSERT (DEFINER → #OO owns the per-graph
//     ACL). KG_QUERY also runs as #OO (DEFINER), so the SELECT in
//     EXPLORE_GRAPH_BULK reads the seeded triples without an
//     "ACL mismatch" rejection.
//   - afterAll best-effort CLEAR GRAPH cleanup via raw SYS.SPARQL_EXECUTE.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { kgQuery } from '../../srv/lib/kg-sparql-client.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_GRAPH = `urn:test:kg-json-contract:${RUN_ID}`;

// Canonical entity-IRI shapes. The EXPLORE_GRAPH_BULK SPARQL filters
// to the 9 edge predicates (kg:teaches, kg:requires, etc.), and the
// projection in srv/lib/kg-projection.js uses the kg/tutorial/<slug>
// and kg/concept/<slug> prefixes — match those so the seeded triples
// participate in the explore graph view.
const KG = 'https://developers.sap.com/kg';
const TUT_A_IRI    = `${KG}/tutorial/test-745-tut-a`;
const TUT_B_IRI    = `${KG}/tutorial/test-745-tut-b`;
const CONCEPT_IRI  = `${KG}/concept/test-745-concept`;

// Three triples covering: subject naming, object naming, and an edge
// between two tutorials via a shared concept. The SPARQL OPTIONAL
// blocks for sName/oName mean we only need kg:name on one side for the
// row to come back — but we attach kg:name to both for clarity.
const SEED_TRIPLES = [
  `<${TUT_A_IRI}> <${KG}/teaches> <${CONCEPT_IRI}> .`,
  `<${TUT_B_IRI}> <${KG}/teaches> <${CONCEPT_IRI}> .`,
  `<${TUT_A_IRI}> <${KG}/name> "Test Tutorial A" .`,
  `<${TUT_B_IRI}> <${KG}/name> "Test Tutorial B" .`,
  `<${CONCEPT_IRI}> <${KG}/name> "Test Concept" .`,
].join('\n');

// Seed via KG_GRAPH_INSERT (DEFINER). CRITICAL: do NOT seed via raw
// SYS.SPARQL_EXECUTE — that would run as application_user and KG_QUERY
// (which runs as #OO) would later be rejected with "User does not have
// access" on the seeded graph. The DO block converts the procedure's
// OUT params to a SELECT result-set readable by db.run().
const DO_CALL_KG_GRAPH_INSERT = `DO (IN p NVARCHAR(500) => ?, IN t NCLOB => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_INSERT(:p, :t, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

// Best-effort cleanup via raw SYS.SPARQL_EXECUTE — cleanup must succeed
// even if the procedure under test is broken (e.g. a future regression
// fires this test file in a half-deployed state).
const DO_RAW_SPARQL = `DO (IN p NCLOB => ?, IN h NVARCHAR(5000) => ?) BEGIN
  DECLARE response NCLOB; DECLARE headers NVARCHAR(5000);
  CALL SYS.SPARQL_EXECUTE(:p, :h, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

describe('SYS.SPARQL_EXECUTE returns JSON via KG_QUERY (regression #745)', () => {
  let db;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';
    db = await cds.connect.to('db');

    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-sparql-execute-json-contract.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.',
      );
    }

    // Seed the per-run TEST_GRAPH via the DEFINER procedure so #OO owns
    // the per-graph ACL — matches the security identity that KG_QUERY
    // will use to SELECT during the actual test.
    await db.run(DO_CALL_KG_GRAPH_INSERT, [TEST_GRAPH, SEED_TRIPLES]);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.run(DO_RAW_SPARQL, [`CLEAR GRAPH <${TEST_GRAPH}>`, '']);
    } catch (err) {
      // Best-effort: surface but don't fail teardown.
      // eslint-disable-next-line no-console
      console.warn(
        `[kg-sparql-execute-json-contract afterAll] CLEAR GRAPH ${TEST_GRAPH} failed:`,
        err?.message,
      );
    }
  });

  it("kgQuery('EXPLORE_GRAPH_BULK') returns JSON, not XML", async () => {
    const { response } = await kgQuery({
      db,
      queryName: 'EXPLORE_GRAPH_BULK',
      params: {},
      overrideGraphIri: TEST_GRAPH,
    });

    // 1. Non-empty response. A bare `''` would also fail the JSON-parse
    //    step, but the dedicated assertion gives a clearer message if
    //    the procedure regresses to silent-empty.
    expect(typeof response).toBe('string');
    expect(response.length).toBeGreaterThan(0);

    // 2. Response must NOT be XML. This is the most specific assertion
    //    against the pre-#743 regression — SPARQL_EXECUTE without an
    //    Accept header returns a `<?xml version="1.0"?>` document.
    //    The fail message names the failure mode explicitly so the next
    //    operator who reads the CI log doesn't have to re-derive it.
    if (response.trim().startsWith('<?xml') || response.trim().startsWith('<sparql')) {
      throw new Error(
        'KG_QUERY(EXPLORE_GRAPH_BULK) returned XML, not JSON. This is the ' +
        'regression PR #743 fixed: SYS_SPARQL_EXECUTE was called without an ' +
        "Accept: application/sparql-results+json header. Restore the Accept " +
        'argument in db/src/procedures/KG_QUERY.hdbprocedure. See issue #745.\n' +
        `Response prefix: ${response.slice(0, 200)}`,
      );
    }

    // 3. JSON.parse must succeed. Belt-and-braces against any non-JSON,
    //    non-XML shape (e.g. HANA error text dumped as the response).
    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch (err) {
      throw new Error(
        `KG_QUERY(EXPLORE_GRAPH_BULK) response is not valid JSON: ${err.message}\n` +
        `Response prefix: ${response.slice(0, 200)}`,
      );
    }

    // 4. Shape: SPARQL JSON-results format wraps rows in
    //    .results.bindings. Without this layer the JS parser at
    //    srv/lib/kg-explore-data.js parseExploreBindings() would
    //    short-circuit to [] (silent swallow — exact bug class).
    expect(parsed, 'parsed payload is not an object').toBeTypeOf('object');
    expect(parsed.results, 'parsed.results is missing').toBeDefined();
    expect(
      Array.isArray(parsed.results?.bindings),
      'parsed.results.bindings is not an array',
    ).toBe(true);

    // 5. We seeded two kg:teaches edges, both of which the bulk query's
    //    predicate filter accepts. At least one binding must come back —
    //    a zero-binding result against a seeded graph means the SPARQL
    //    layer succeeded structurally but produced no rows, which is
    //    its own regression class (filter shape changed, prefix changed,
    //    ACL silently rejected on the SELECT side, etc.).
    expect(
      parsed.results.bindings.length,
      'expected ≥1 binding from EXPLORE_GRAPH_BULK against the seeded test graph',
    ).toBeGreaterThan(0);
  }, 60_000);
});
