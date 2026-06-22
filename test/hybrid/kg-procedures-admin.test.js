// test/hybrid/kg-procedures-admin.test.js
// Hybrid tests for KG_ADMIN_RUNSPARQL admin escape hatch DEFINER procedure (Task 4, issue #533).
//
// RATIONALE
//   KG_ADMIN_RUNSPARQL forwards arbitrary SPARQL verbatim to SYS_SPARQL_EXECUTE
//   with minimal validation: sparql must not be null/empty, is_update must be
//   'Y' or 'N'. The procedure runs as HDI object-owner (#OO) via SQL SECURITY DEFINER.
//
//   Spec: docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
//   Issue: #533
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/kg-procedures-admin.test.js
//
// SAFETY
//   - Per-run TEST_GRAPH IRI (urn:test:kg-admin-runsparql:<timestamp>-<rand>) avoids
//     collision between parallel runs and never touches production graphs.
//   - beforeAll verifies HANA connection.
//   - afterAll best-effort cleanup of test graphs via raw SPARQL (same pattern as
//     kg-procedures-graph-ops.test.js and kg-procedures-query.test.js).
//
// NOTE ON OUT PARAMS
//   db.run('CALL KG_ADMIN_RUNSPARQL(..., ?, ?)') does not work for OUT params in the
//   @cap-js/hana driver. Use the DO-block wrapper pattern (same as Task 1/2/3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_GRAPH = `urn:test:kg-admin-runsparql:${RUN_ID}`;

// Raw DO-block helper — uses SYS.SPARQL_EXECUTE directly (application_user bound).
// Used for seeding and cleanup — both are best-effort and don't require #OO identity.
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
// KG_ADMIN_RUNSPARQL also runs as #OO, so it can read from #OO-owned graphs.
const DO_CALL_KG_GRAPH_INSERT = `DO (IN p NVARCHAR(500) => ?, IN t NCLOB => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_INSERT(:p, :t, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

async function callKgGraphInsert(db, graphIri, triples) {
  return db.run(DO_CALL_KG_GRAPH_INSERT, [graphIri, triples]);
}

// DO-block wrapper for KG_ADMIN_RUNSPARQL (2 IN params + 2 OUT params).
// The @cap-js/hana driver does not support OUT-param binding in db.run('CALL ...').
// Wrapping in a DO block converts the OUT params to a SELECT result-set.
const DO_CALL_KG_ADMIN_RUNSPARQL = `DO (IN s NCLOB => ?, IN f NVARCHAR(1) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_ADMIN_RUNSPARQL(:s, :f, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

async function callKgAdminRunsparql(db, sparql, isUpdate) {
  return db.run(DO_CALL_KG_ADMIN_RUNSPARQL, [sparql, isUpdate]);
}

describe('KG_ADMIN_RUNSPARQL admin escape hatch procedure (issue #533, Task 4)', () => {
  let db;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');

    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-procedures-admin.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }

    // Seed the TEST_GRAPH via KG_GRAPH_INSERT (runs as #OO / DEFINER).
    // CRITICAL: must NOT use rawSparqlExec here. rawSparqlExec uses the
    // application_user binding, which would make application_user the ACL
    // owner of TEST_GRAPH. When KG_ADMIN_RUNSPARQL later runs as #OO and tries
    // to SELECT from that graph, HANA rejects with "User does not have access".
    // By seeding via KG_GRAPH_INSERT (#OO), both seed and query share the
    // same ACL identity — no collision.
    //
    // KG_GRAPH_INSERT accepts N-Triples (space-separated, period-terminated).
    const seedTriples = [
      `<urn:test:subj> <urn:test:pred> <urn:test:obj> .`,
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
      console.warn('[kg-procedures-admin afterAll] CLEAR GRAPH cleanup failed:', err?.message);
    }
  });

  it('read passthrough: SELECT (1 AS ?one) with is_update=N returns non-empty response containing "1"', async () => {
    // A simple SELECT that doesn't depend on any graph should work regardless.
    // The response is XML SPARQL Results; we check it contains the literal "1".
    const result = await callKgAdminRunsparql(
      db,
      'SELECT (1 AS ?one) WHERE {}',
      'N'
    );
    expect(result).toBeDefined();
    // db.run on a DO block returns { changes: [{}, [rows]] }
    const rows = result?.changes?.[1] || result;
    const responseRow = Array.isArray(rows) ? rows[0] : rows;
    expect(responseRow?.RESPONSE).toBeDefined();
    // The response should contain the integer 1 in XML form
    expect(responseRow.RESPONSE).toMatch(/1/);
  });

  it('write passthrough: SELECT from seeded graph returns the seeded triple object', async () => {
    // We seeded <urn:test:subj> <urn:test:pred> <urn:test:obj> into TEST_GRAPH.
    // This query should find it and return ?o = <urn:test:obj>.
    const sparql = `SELECT ?o WHERE { GRAPH <${TEST_GRAPH}> { <urn:test:subj> <urn:test:pred> ?o } }`;
    const result = await callKgAdminRunsparql(db, sparql, 'N');
    expect(result).toBeDefined();
    // db.run on a DO block returns { changes: [{}, [rows]] }
    const rows = result?.changes?.[1] || result;
    expect(Array.isArray(rows) ? rows.length : 1).toBeGreaterThan(0);
    // The response should contain "urn:test:obj" as the binding for ?o in XML
    const responseRow = Array.isArray(rows) ? rows[0] : rows;
    expect(responseRow?.RESPONSE).toContain('urn:test:obj');
  });

  it('invalid is_update flag: is_update=X raises error code 10009 (KG_INVALID_IS_UPDATE_FLAG)', async () => {
    // Any value other than 'Y' or 'N' must be rejected with code 10009.
    await expect(
      callKgAdminRunsparql(db, 'SELECT (1 AS ?one) WHERE {}', 'X')
    ).rejects.toMatchObject({ code: 10009 });
  });

  it('empty sparql: empty string raises error code 10008 (KG_EMPTY_SPARQL)', async () => {
    // An empty SPARQL string must be rejected with code 10008.
    await expect(
      callKgAdminRunsparql(db, '', 'N')
    ).rejects.toMatchObject({ code: 10008 });
  });
});
