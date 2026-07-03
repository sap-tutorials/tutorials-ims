// srv/lib/kg-path-v2-client.js
// Typed wrapper for the KG_PATH_V2 DEFINER procedure. Separate module from
// kg-sparql-client.js because this doesn't speak SPARQL — it calls the HANA
// property-graph engine via a stored procedure over the KG_PG_WORKSPACE
// view-based workspace.
//
// Contract:
//   kgPathV2({ fromIri, toIri, maxHops = 8, timeoutMs = 5000 })
//     → Promise<Array<{ pathRank, hopCount, vertices: string[] }>>
//
// Error codes surfaced to callers via err.code:
//   10006  KG_INVALID_TUTORIAL_IRI   — IRI regex mismatch (pre-check + DB)
//   10010  KG_MAX_HOPS_OUT_OF_RANGE  — maxHops not in [1, 20]
//   'ETIMEDOUT' — HANA didn't return within timeoutMs. Fires when the two
//                 endpoints have no path AND the workspace is large enough
//                 that Shortest_Path's exhaustive BFS dominates. Live probe
//                 2026-07-03: 6054 vertices / 7164 edges, a nonexistent
//                 pair timed out at 30s in hana-cli. Default 5000ms bound
//                 matches the v1 SPARQL kgQuery() withTimeout wrapper.

import cds from '@sap/cds';

const IRI_RX = /^https:\/\/developers\.sap\.com\/kg\/tutorial\/[a-z0-9-]{1,80}$/;
const DEFAULT_TIMEOUT_MS = 5000;

// DO-block converts the OUT TABLE(...) param to a SELECT result-set. Matches
// the pattern in kg-sparql-client.js — @cap-js/hana does not bind OUT params
// via db.run('CALL …'), so DO-with-embedded-SELECT is the workaround.
const DO_KG_PATH_V2 = `DO (
  IN from_iri NVARCHAR(500) => ?,
  IN to_iri   NVARCHAR(500) => ?,
  IN max_hops INTEGER       => ?
) BEGIN
  DECLARE paths TABLE (
    path_rank   INTEGER,
    hop_count   INTEGER,
    vertex_seq  NVARCHAR(500),
    seq_index   INTEGER
  );
  CALL KG_PATH_V2(:from_iri, :to_iri, :max_hops, :paths);
  SELECT * FROM :paths;
END`;

// Promise.race timeout — mirrors withTimeout() in srv/lib/kg-sparql-client.js.
// The rejected promise resolves before HANA does, but HANA continues running
// server-side; that's acceptable because the query is read-only and short
// under normal conditions (path exists → returns in ~50ms per probe).
function withTimeout(promise, timeoutMs, fromIri, toIri) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`kgPathV2 timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      err.timeoutMs = timeoutMs;
      err.fromIri = fromIri;
      err.toIri = toIri;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export async function kgPathV2({ fromIri, toIri, maxHops = 8, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!IRI_RX.test(fromIri) || !IRI_RX.test(toIri)) {
    const err = new Error('KG_INVALID_TUTORIAL_IRI');
    err.code = 10006;
    throw err;
  }
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 20) {
    const err = new Error('KG_MAX_HOPS_OUT_OF_RANGE');
    err.code = 10010;
    throw err;
  }

  const rows = await withTimeout(
    cds.db.run(DO_KG_PATH_V2, [fromIri, toIri, maxHops]),
    timeoutMs,
    fromIri,
    toIri,
  );
  // Coerce the DO-block result — @cap-js/hana wraps it as {changes: [{},[rows]]}
  // in production, but tests / other drivers return a plain array. Match the
  // shape defensively (mirrors coerceRow() in kg-sparql-client.js).
  const flat = Array.isArray(rows)
    ? (Array.isArray(rows[0]) ? rows[0] : rows)
    : (rows?.changes?.[1] ?? []);

  const byRank = new Map();
  for (const r of flat) {
    let bucket = byRank.get(r.PATH_RANK);
    if (!bucket) {
      bucket = { pathRank: r.PATH_RANK, hopCount: r.HOP_COUNT, vertices: [] };
      byRank.set(r.PATH_RANK, bucket);
    }
    bucket.vertices[r.SEQ_INDEX] = r.VERTEX_SEQ;
  }

  // Defense-in-depth: interior vertices must all be concepts (endpoints
  // are tutorials). Guards against a bad workspace refresh.
  const filtered = [...byRank.values()].filter(p => {
    if (p.vertices.length < 3) return false; // must have at least one interior
    const interior = p.vertices.slice(1, -1);
    return interior.every(v => typeof v === 'string' && v.startsWith('concept:'));
  });

  // Stable ordering — primary by path_rank, tie-break by joined vertex_seq.
  return filtered.sort((a, b) => {
    if (a.pathRank !== b.pathRank) return a.pathRank - b.pathRank;
    return a.vertices.join('|').localeCompare(b.vertices.join('|'));
  });
}
