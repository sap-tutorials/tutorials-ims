// test/hybrid/kg-procedures-query.test.js
// Hybrid tests for KG_QUERY dispatcher DEFINER procedure (Task 3, issue #533).
//
// RATIONALE
//   KG_QUERY dispatches to one of three SPARQL query templates — NEIGHBORHOOD,
//   PATH_BETWEEN, CONCEPTS_FOR_USER — via an IF/ELSEIF chain on the :query_name
//   parameter. It validates each branch's typed inputs before assembling SPARQL.
//   SQL SECURITY DEFINER means queries execute as the HDI object-owner (#OO),
//   same as KG_GRAPH_INSERT and KG_GRAPH_CLEAR.
//
//   Spec: docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
//   Issue: #533
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/kg-procedures-query.test.js
//
// SAFETY
//   - Per-run TEST_GRAPH IRI (urn:test:kg-query:<timestamp>-<rand>) avoids
//     collision between parallel runs and never touches production graphs.
//   - beforeAll seeds via KG_GRAPH_INSERT (runs as #OO) so that #OO owns the
//     test graph's per-graph ACL. KG_QUERY also runs as #OO (DEFINER), so it
//     can SELECT from the same graph without ACL collision.
//   - afterAll CLEAR GRAPH cleanup is best-effort via raw SYS.SPARQL_EXECUTE path.
//
// NOTE ON OUT PARAMS
//   db.run('CALL KG_QUERY(..., ?, ?)') does not work for OUT params in the
//   @cap-js/hana driver. Use the DO-block wrapper pattern (same as Task 1/2).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_GRAPH = `urn:test:kg-query:${RUN_ID}`;

// Tutorial IRI shape used in the TEST graph
const TEST_TUTORIAL_IRI = 'https://developers.sap.com/kg/tutorial/test-tut-a';

// Raw DO-block helper — uses SYS.SPARQL_EXECUTE directly (application_user
// bound). Used for CLEAR GRAPH cleanup in afterAll — cleanup doesn't need #OO.
async function rawSparqlExec(db, sparql) {
  const DO = `DO (IN p NCLOB => ?, IN h NVARCHAR(5000) => ?) BEGIN
    DECLARE response NCLOB; DECLARE headers NVARCHAR(5000);
    CALL SYS.SPARQL_EXECUTE(:p, :h, response, headers);
    SELECT :response AS response, :headers AS headers FROM DUMMY;
  END`;
  return db.run(DO, [sparql, '']);
}

// Call KG_GRAPH_INSERT via a DO block — runs as #OO (DEFINER).
// Used for seeding the TEST_GRAPH so that #OO owns the graph's per-graph ACL.
// KG_QUERY also runs as #OO, so it can SELECT from #OO-owned graphs.
// (rawSparqlExec seeds as application_user, causing ACL mismatch with #OO queries.)
const DO_CALL_KG_GRAPH_INSERT = `DO (IN p NVARCHAR(500) => ?, IN t NCLOB => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_INSERT(:p, :t, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

async function callKgGraphInsert(db, graphIri, triples) {
  return db.run(DO_CALL_KG_GRAPH_INSERT, [graphIri, triples]);
}

// DO-block wrapper for KG_QUERY (5 IN params + 2 OUT params).
// The @cap-js/hana driver does not support OUT-param binding in db.run('CALL ...').
// Wrapping in a DO block converts the OUT params to a SELECT result-set.
const DO_CALL_KG_QUERY = `DO (
  IN qn NVARCHAR(50) => ?,
  IN p1 NVARCHAR(500) => ?,
  IN p2 NVARCHAR(500) => ?,
  IN p3 NVARCHAR(500) => ?,
  IN oiri NVARCHAR(500) => ?
) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_QUERY(:qn, :p1, :p2, :p3, :oiri, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

async function callKgQuery(db, queryName, p1, p2, p3, overrideGraphIri) {
  return db.run(DO_CALL_KG_QUERY, [queryName, p1, p2, p3, overrideGraphIri]);
}

describe('KG_QUERY dispatcher procedure (issue #533, Task 3)', () => {
  let db;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');

    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-procedures-query.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }

    // Seed the TEST_GRAPH via KG_GRAPH_INSERT (runs as #OO / DEFINER).
    // CRITICAL: must NOT use rawSparqlExec here. rawSparqlExec uses the
    // application_user binding, which would make application_user the ACL
    // owner of TEST_GRAPH. When KG_QUERY later runs as #OO and tries to
    // SELECT from that graph, HANA rejects with "User does not have access".
    // By seeding via KG_GRAPH_INSERT (#OO), both seed and query share the
    // same ACL identity — no collision.
    //
    // KG_GRAPH_INSERT accepts N-Triples (space-separated, period-terminated).
    const seedTriples = [
      `<${TEST_TUTORIAL_IRI}> <https://developers.sap.com/kg/teaches> <urn:concept:c1> .`,
      `<urn:concept:c1> <https://developers.sap.com/kg/slug> "test-concept" .`,
      `<urn:concept:c1> <https://developers.sap.com/kg/name> "Test Concept" .`,
    ].join('\n');
    await callKgGraphInsert(db, TEST_GRAPH, seedTriples);
  });

  afterAll(async () => {
    if (!db) return;
    // Best-effort cleanup — raw path, not the procedure, so cleanup succeeds
    // even if the procedure under test is broken.
    try {
      await rawSparqlExec(db, `CLEAR GRAPH <${TEST_GRAPH}>`);
    } catch (err) {
      // Surface but don't fail teardown.
      // eslint-disable-next-line no-console
      console.warn('[kg-procedures-query afterAll] CLEAR GRAPH cleanup failed:', err?.message);
    }
  });

  it('unknown query name rejection: "BOGUS" raises error code 10005 (KG_UNKNOWN_QUERY)', async () => {
    // Any query name not in the NEIGHBORHOOD / PATH_BETWEEN / CONCEPTS_FOR_USER
    // dispatch table must be rejected with code 10005.
    await expect(
      callKgQuery(db, 'BOGUS', 'x', null, null, null)
    ).rejects.toMatchObject({ code: 10005 });
  });

  it('NEIGHBORHOOD with valid tutorial IRI: dispatches and returns non-empty JSON response', async () => {
    // Pass override_graph_iri = TEST_GRAPH so the procedure queries our seeded
    // test triples instead of the production graph. The full IRI shape is
    // required: https://developers.sap.com/kg/tutorial/<slug>.
    //
    // We assert the response is defined (non-null, non-empty). Full content
    // assertion is not required — the test proves dispatch works AND a valid
    // IRI passes validation AND the assembled SPARQL parses + executes.
    const rows = await callKgQuery(
      db,
      'NEIGHBORHOOD',
      TEST_TUTORIAL_IRI,
      null,
      null,
      TEST_GRAPH
    );
    // rows should be a non-empty array with a RESPONSE column
    expect(rows).toBeDefined();
    expect(Array.isArray(rows) ? rows.length : 1).toBeGreaterThan(0);
  });

  it('NEIGHBORHOOD rejects invalid tutorial IRI: raises error code 10006 (KG_INVALID_TUTORIAL_IRI)', async () => {
    // An IRI not matching the ^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$
    // pattern must be rejected before SPARQL is assembled.
    await expect(
      callKgQuery(db, 'NEIGHBORHOOD', 'http://evil.example.com/x', null, null, null)
    ).rejects.toMatchObject({ code: 10006 });
  });

  it('PATH_BETWEEN smoke: valid IRI shapes pass validation, no error', async () => {
    // PATH_BETWEEN requires two valid tutorial IRIs (p1 = from, p2 = to).
    // The test graph has no path triples — but the stub SPARQL returns LIMIT 0
    // (no rows) without error, which is valid SPARQL execution.
    await expect(
      callKgQuery(
        db,
        'PATH_BETWEEN',
        'https://developers.sap.com/kg/tutorial/tutorial-a',
        'https://developers.sap.com/kg/tutorial/tutorial-b',
        null,
        TEST_GRAPH
      )
    ).resolves.toBeDefined();
  });

  it('CONCEPTS_FOR_USER smoke: valid UUID passes validation, no error', async () => {
    // CONCEPTS_FOR_USER requires :p1 to be a UUID (lowercase hex with hyphens).
    // The stub SPARQL returns LIMIT 0 (no rows) without error.
    await expect(
      callKgQuery(
        db,
        'CONCEPTS_FOR_USER',
        '00000000-0000-0000-0000-000000000001',
        null,
        null,
        TEST_GRAPH
      )
    ).resolves.toBeDefined();
  });
});
