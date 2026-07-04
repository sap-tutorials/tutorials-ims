#!/usr/bin/env node
// Task 0 probe for #917 KG community detection.
//
// Confirms HANA GraphScript's `Communities_Louvain` builtin compiles and
// returns rows at our HANA Cloud version — WITHOUT deploying an HDI
// artifact. We instead create a session-local procedure at runtime via
// raw SQL, call it, and drop it. Rationale: the HDI deploy path fails
// in this hybrid setup because `tutorials-kg-grantor` isn't visible
// locally; the runtime-only path exercises the same primitive.

import cds from '@sap/cds';

const PROC_NAME = 'KG_LOUVAIN_PROBE_TASK0';

const CREATE_SQL = `CREATE PROCEDURE "${PROC_NAME}" (
  OUT o_result TABLE (
    community_id BIGINT,
    vertex_count BIGINT
  )
)
LANGUAGE GRAPH READS SQL DATA AS
BEGIN
  GRAPH g = Graph("KG_PG_WORKSPACE");
  MULTISET<INTEGER> communities = Communities_Louvain(:g);
  o_result = SELECT :community AS community_id,
                    COUNT(*)   AS vertex_count
             FROM :communities
             GROUP BY :community
             ORDER BY :community;
END`;

const db = await cds.connect.to('db');

async function tryDrop() {
  try {
    await db.run(`DROP PROCEDURE "${PROC_NAME}"`);
  } catch (_) {
    // ignore
  }
}

// Best-effort clean of any prior partial run.
await tryDrop();

try {
  const tCreate0 = Date.now();
  await db.run(CREATE_SQL);
  const tCreate = Date.now() - tCreate0;

  const tRun0 = Date.now();
  const rows = await db.run(`CALL "${PROC_NAME}"()`);
  const tRun = Date.now() - tRun0;

  const communities = rows.length;
  const totalVerts = rows.reduce(
    (s, r) => s + Number(r.VERTEX_COUNT ?? r.vertex_count ?? 0),
    0,
  );

  await tryDrop();

  console.log(
    JSON.stringify(
      {
        ok: true,
        communities,
        totalVerts,
        createMs: tCreate,
        runMs: tRun,
        sample: rows.slice(0, 5),
      },
      null,
      2,
    ),
  );
  process.exit(0);
} catch (err) {
  await tryDrop();
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: err.message,
        code: err.code,
        sqlState: err.sqlState,
        stack: err.stack?.split('\n').slice(0, 5),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
