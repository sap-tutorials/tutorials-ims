// test/hybrid/kg-procedures-graph-ops.test.js
// Hybrid tests for KG SQLScript DEFINER procedures — KG_GRAPH_CLEAR (Task 1)
// and KG_GRAPH_INSERT (Task 2, to be appended later).
//
// RATIONALE
//   These procedures replace the raw SYS.SPARQL_EXECUTE DO-block pattern.
//   Each runs with SQL SECURITY DEFINER so every SPARQL call reaches HANA
//   as the HDI container object-owner (#OO) regardless of which binding
//   invoked it. This eliminates per-graph ACL collisions where different
//   runtime users were locking graphs to their own identity.
//
//   Spec: docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
//   Issue: #533
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/kg-procedures-graph-ops.test.js
//
// SAFETY
//   - Per-run TEST_GRAPH IRI (urn:test:kg-procs:<timestamp>-<rand>) avoids
//     collision between parallel runs and never touches production graphs.
//   - beforeAll seeds via raw DO BEGIN CALL SYS.SPARQL_EXECUTE END (NOT via
//     the procedure under test) so we're testing the procedure, not its input.
//   - afterAll CLEAR GRAPHs via the same raw path (best-effort).
//
// NOTE ON OUT PARAMS
//   db.run('CALL KG_GRAPH_CLEAR(?, ?, ?)', [iri, null, null]) — the two
//   trailing nulls reserve the OUT-param slots; the HANA driver fills them
//   on return.  The result row shape is [{ RESPONSE, HEADERS }] or similar.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_GRAPH = `urn:test:kg-procs:${RUN_ID}`;

// Raw DO-block helper — used for seed/cleanup so the test does NOT use the
// procedure under test for setup, keeping the test properly isolated.
async function rawSparqlExec(db, sparql) {
  const DO = `DO (IN p NCLOB => ?, IN h NVARCHAR(5000) => ?) BEGIN
    DECLARE response NCLOB; DECLARE headers NVARCHAR(5000);
    CALL SYS.SPARQL_EXECUTE(:p, :h, response, headers);
    SELECT :response AS response, :headers AS headers FROM DUMMY;
  END`;
  return db.run(DO, [sparql, '']);
}

// Call the KG_GRAPH_CLEAR procedure via a DO block.
// The @cap-js/hana driver does not support OUT-param binding in db.run('CALL ...').
// Wrapping in a DO block (same pattern as the legacy SPARQL_DO_BLOCK) converts
// the OUT params to a SELECT result-set that db.run() can read.
const DO_CALL_KG_GRAPH_CLEAR = `DO (IN p NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_CLEAR(:p, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

// Call the KG_GRAPH_CLEAR procedure. Returns the raw db.run result.
async function callKgGraphClear(db, graphIri) {
  return db.run(DO_CALL_KG_GRAPH_CLEAR, [graphIri]);
}

// Call the KG_GRAPH_INSERT procedure via a DO block.
// Signature: KG_GRAPH_INSERT(graph_iri, triples, OUT response, OUT headers)
// The DO block exposes the OUT params as a SELECT result-set for db.run().
const DO_CALL_KG_GRAPH_INSERT = `DO (IN p NVARCHAR(500) => ?, IN t NCLOB => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_INSERT(:p, :t, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

// Call the KG_GRAPH_INSERT procedure. Returns the raw db.run result.
async function callKgGraphInsert(db, graphIri, triples) {
  return db.run(DO_CALL_KG_GRAPH_INSERT, [graphIri, triples]);
}

describe('KG_GRAPH_CLEAR procedure (issue #533, Phase 1.5)', () => {
  let db;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');

    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-procedures-graph-ops.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }

    // Seed a triple into the test graph via raw SPARQL (NOT via the procedure
    // under test). This proves the graph exists before CLEAR is called.
    await rawSparqlExec(
      db,
      `INSERT DATA { GRAPH <${TEST_GRAPH}> { <urn:seed:s> <urn:seed:p> <urn:seed:o> . } }`
    );
  });

  afterAll(async () => {
    if (!db) return;
    // Best-effort cleanup — raw path, not the procedure, so cleanup doesn't
    // fail if the procedure itself is broken.
    try {
      await rawSparqlExec(db, `CLEAR GRAPH <${TEST_GRAPH}>`);
    } catch (err) {
      // Surface but don't fail teardown.
      // eslint-disable-next-line no-console
      console.warn('[kg-procedures-graph-ops afterAll] CLEAR GRAPH cleanup failed:', err?.message);
    }
  });

  it('happy path: KG_GRAPH_INSERT seeds graph as #OO, then KG_GRAPH_CLEAR succeeds (full create+wipe cycle)', async () => {
    // Tightened in Task 2: seed the graph via KG_GRAPH_INSERT (which runs as
    // #OO via DEFINER) so the graph's per-graph ACL is owned by #OO — not by
    // the raw application_user binding. KG_GRAPH_CLEAR then succeeds because
    // both operations share the same #OO identity.
    //
    // This is the core proof of the DEFINER design: KG_GRAPH_INSERT creates
    // the graph as #OO → KG_GRAPH_CLEAR can clear it as #OO (no ACL collision).
    const clearGraph = `${TEST_GRAPH}:clear-happy`;

    // Seed via KG_GRAPH_INSERT (runs as #OO)
    await expect(callKgGraphInsert(db, clearGraph, '<urn:s> <urn:p> <urn:o> .')).resolves.toBeDefined();

    // CLEAR via KG_GRAPH_CLEAR — must succeed (no error)
    await expect(callKgGraphClear(db, clearGraph)).resolves.toBeDefined();
  });


  it('invalid IRI rejection: "not-an-iri" raises error code 10001 (KG_INVALID_IRI)', async () => {
    // HANA Cloud SQLScript SIGNAL raises err.code === 10001 (user-defined range).
    // The condition is named KG_INVALID_IRI in the procedure body.
    await expect(callKgGraphClear(db, 'not-an-iri')).rejects.toMatchObject({ code: 10001 });
  });

  it('over-length IRI (501 chars) raises error code 10001 (KG_INVALID_IRI)', async () => {
    const longIri = 'urn:test:' + 'x'.repeat(501 - 'urn:test:'.length + 1); // guaranteed > 500
    // The DO-block wrapper has `IN p NVARCHAR(500)` which means strings > 500
    // chars are rejected by HANA at the parameter-binding layer (code 359:
    // "string is too long") before the procedure's LENGTH check (code 10001)
    // ever runs. Both codes prove the IRI was correctly rejected.
    await expect(callKgGraphClear(db, longIri)).rejects.toSatisfy(
      (err) => err.code === 10001 || err.code === 359
    );
  });
});

// ---------------------------------------------------------------------------
// KG_GRAPH_INSERT procedure (Task 2)
// ---------------------------------------------------------------------------

describe('KG_GRAPH_INSERT procedure (issue #533, Task 2)', () => {
  let db;

  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');

    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-procedures-graph-ops.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    // Best-effort cleanup of any graphs created during INSERT tests.
    const graphsToClean = [
      `${TEST_GRAPH}:insert-happy`,
      `${TEST_GRAPH}:insert-cycle`,
    ];
    for (const g of graphsToClean) {
      try {
        await rawSparqlExec(db, `CLEAR GRAPH <${g}>`);
      } catch {
        // ignore — graph may not have been created
      }
    }
  });

  it('happy path: KG_GRAPH_INSERT creates graph as #OO; KG_GRAPH_CLEAR then succeeds (full create+wipe cycle)', async () => {
    // Core proof of the DEFINER design: INSERT creates via #OO → CLEAR succeeds
    // as #OO on the same graph. No per-graph ACL collision.
    const insertGraph = `${TEST_GRAPH}:insert-happy`;

    // Create the graph via KG_GRAPH_INSERT — runs as #OO (DEFINER)
    await expect(
      callKgGraphInsert(db, insertGraph, '<urn:a> <urn:b> <urn:c> .')
    ).resolves.toBeDefined();

    // CLEAR the same graph via KG_GRAPH_CLEAR — must succeed (same #OO owner)
    await expect(callKgGraphClear(db, insertGraph)).resolves.toBeDefined();
  });

  it('invalid IRI rejection: "not-an-iri" raises error code 10001 (KG_INVALID_IRI)', async () => {
    // Same IRI validation as KG_GRAPH_CLEAR — must reuse the same regex + error code.
    await expect(
      callKgGraphInsert(db, 'not-an-iri', '<urn:a> <urn:b> <urn:c> .')
    ).rejects.toMatchObject({ code: 10001 });
  });

  it('empty triples rejection: empty string raises error code 10003 (KG_EMPTY_TRIPLES)', async () => {
    // Passing an empty string for triples would produce a syntactically invalid
    // SPARQL INSERT DATA statement — must be rejected before SPARQL execution.
    await expect(
      callKgGraphInsert(db, `${TEST_GRAPH}:empty-triples`, '')
    ).rejects.toMatchObject({ code: 10003 });
  });

  it('defensive "} }" injection attempt raises error code 10004 (KG_TRIPLES_INVALID)', async () => {
    // Attack payload: closes the INSERT DATA { GRAPH <iri> { block early, then
    // injects a second INSERT DATA statement for a different graph.
    // The procedure must detect the "} }" pattern and reject before executing.
    const attackPayload =
      '<urn:a> <urn:b> <urn:c> . } } INSERT DATA { GRAPH <urn:evil> { <urn:x> <urn:x> <urn:x> . ';
    await expect(
      callKgGraphInsert(db, `${TEST_GRAPH}:injection`, attackPayload)
    ).rejects.toMatchObject({ code: 10004 });
  });
});
