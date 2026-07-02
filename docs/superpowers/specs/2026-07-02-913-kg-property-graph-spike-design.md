# KG Property Graph spike — design

**Status:** Design for [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913).
**Date:** 2026-07-02
**Branch:** `feat/kg-property-graph-spike` (to be created from this design)

## Problem

The current `pathBetween` implementation in [db/src/procedures/KG_QUERY.hdbprocedure](../../../db/src/procedures/KG_QUERY.hdbprocedure) uses a three-arm SPARQL UNION (PREREQ / CO_COMPLETED / SHARED_CONCEPT). The PREREQ arm — the one that walks prerequisite chains via `kg:requires` closure — has a documented limitation called out in the procedure body itself:

> HANA KGE does NOT support {n,m} counted-range property paths (Task 0 spike confirmed 'Unsupported functionality: Path repeat range'). We use + (plus closure, one-or-more hops) instead. Depth bounded by LIMIT 10 and the 5s wall-clock timeout enforced by kgQuery()'s withTimeout wrapper.

As a result, every PREREQ-arm result today returns `hopCount = 0` (see [KG_QUERY.hdbprocedure:216](../../../db/src/procedures/KG_QUERY.hdbprocedure#L216)) — the SPARQL engine can't compute hop counts, so we bind a placeholder zero. The sidebar widget's UX and the Joule path-between tool would both be strictly better with real hop-bounded, hop-counted shortest paths.

The 2026-Q3 HANA Cloud release added a **Property Graph Workspace projection** over the RDF graph, unlocking the separate HANA Graph Engine's algorithm library — including `SHORTEST_PATH` with real hop-bounded queries and real hop-count output. Tom confirmed on 2026-07-01 that the HANA instance for the DevRel & Community Tools subaccount was upgraded and the property-graph entitlement is enabled.

This spec designs a one-week spike to introduce the Property Graph Engine into the tutorials-ims Knowledge Graph pipeline. The pilot algorithm is `SHORTEST_PATH`, applied to the PREREQ arm only. A qualitative team review at end of week decides whether to expand to PageRank, community detection, and weakly-connected components (each tracked as a separate follow-on issue filed alongside this spec).

## Approach

Add one HDI DEFINER procedure (`KG_PATH_V2.hdbprocedure`), one property-graph workspace (`KG_PG_WORKSPACE.hdbgraphworkspace`) built on **views** over the existing `Concepts`, `ConceptEdges`, `Tutorials`, and `TutorialConceptLinks` CDS tables, one JS wrapper (`srv/lib/kg-path-v2-client.js`), and one handler edit in `srv/knowledge-graph-service.js`. The handler gates behavior on a new env flag `KG_PATH_V2_ENABLED` — off by default. When on, the PREREQ arm uses `SHORTEST_PATH` via the new procedure; empty results and any error fall through to the existing SPARQL implementation.

The workspace is deliberately view-based (not materialized) so the RDF graph and the property graph share one source of truth (the CDS tables) and cannot drift. `srv/lib/kg-graph-rebuild.js` is unchanged.

The DEFINER-security pattern is preserved from the existing SPARQL DEFINER work ([spec](2026-06-22-kg-sparql-definer-procedures-design.md), [#533](https://github.com/sap-tutorials/tutorials-ims/pull/533)): the procedure body runs as the HDI container's object-owner user regardless of which runtime user calls it, so per-workspace ACL (if HANA applies one) pins to a stable identity across bindings.

## Architecture

```text
                       BEFORE                                       AFTER (spike, flag ON)
                       ──────                                       ─────────────────────

  pathBetween handler                                    pathBetween handler
     │                                                        │
     │ (single call)                                          │ KG_PATH_V2_ENABLED?
     ▼                                                        │
  kgPathBetween()  ──►  KG_QUERY('PATH_BETWEEN')              ├─► NO  ──► kgPathBetween() (unchanged)
     │                     3-arm UNION SPARQL                 │
     │                     PREREQ / CO_COMP / SHARED          └─► YES ──┬─► kgPathV2()  ──► KG_PATH_V2 procedure
     ▼                                                                   │        │           SHORTEST_PATH over
   response                                                              │        │           KG_PG_WORKSPACE
                                                                         │        ▼
                                                                         │      RESULT: (iri, hopIdx) rows
                                                                         │
                                                                         └─► kgPathBetween('CO_COMPLETED')  (SPARQL)
                                                                                 kgPathBetween('SHARED')    (SPARQL)
                                                                                 merge + rank in JS
```

**New artifacts (two files):**

- `db/src/procedures/KG_PATH_V2.hdbprocedure` — new DEFINER procedure. Validates IRIs, calls `SHORTEST_PATH` over `KG_PG_WORKSPACE`, returns a table.
- `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace` — declares vertices and edges via views on `Concepts`, `Tutorials`, `ConceptEdges`, and `TutorialConceptLinks`.

**New view definitions (two files under `db/src/views/`):**

- `db/src/views/KG_PG_VERTICES_V.hdbview` — union of concept and tutorial vertex projections.
- `db/src/views/KG_PG_EDGES_V.hdbview` — union of `requires` (concept→concept) and `teaches` (tutorial→concept) edge projections.

**New JS module (one file):**

- `srv/lib/kg-path-v2-client.js` — typed wrapper around the procedure call, mirroring the shape of `srv/lib/kg-sparql-client.js` but not folded into it because it doesn't speak SPARQL.

**One handler edit:**

- `srv/knowledge-graph-service.js` — `pathBetween` handler gains a flag check and a fail-open-to-v1 fallback.

**Rebuild path unchanged:** [srv/lib/kg-graph-rebuild.js](../../../srv/lib/kg-graph-rebuild.js) does not change. Because the workspace is view-based, it is always current with the CDS tables that the RDF projection also reads.

**QA channel:** matching stub procedures under `db-qa/src/procedures/KG_PATH_V2.hdbprocedure` that signal `KG_NOT_AVAILABLE_ON_QA`, mirroring the pattern established in the SPARQL DEFINER spec's [QA channel section](2026-06-22-kg-sparql-definer-procedures-design.md#qa-channel).

## Data model — the property-graph workspace

### Vertex view: `KG_PG_VERTICES_V`

```sql
CREATE VIEW "KG_PG_VERTICES_V" AS
  -- Concept vertices
  SELECT
    'concept:' || slug        AS "VERTEX_KEY",
    'concept'                 AS "VERTEX_TYPE",
    slug                      AS "SLUG",
    name                      AS "LABEL",
    status                    AS "STATUS"
  FROM "com_sap_developers_ims_Concepts"
  WHERE status = 'ACTIVE'
  UNION ALL
  -- Tutorial vertices (synthesized from the link table — tutorials don't
  -- live in a KG-specific table, they live in Tutorials).
  SELECT DISTINCT
    'tutorial:' || t.slug     AS "VERTEX_KEY",
    'tutorial'                AS "VERTEX_TYPE",
    t.slug                    AS "SLUG",
    t.title                   AS "LABEL",
    NULL                      AS "STATUS"
  FROM "com_sap_developers_ims_TutorialConceptLinks" tcl
  JOIN "com_sap_developers_ims_Tutorials" t ON t.ID = tcl.tutorial_ID;
```

`VERTEX_KEY` is the workspace's primary key. The `concept:` / `tutorial:` prefixes prevent collisions between concept slugs and tutorial slugs, which share a slug namespace at the CDS level but are disambiguated at the KG IRI layer.

### Edge view: `KG_PG_EDGES_V`

```sql
CREATE VIEW "KG_PG_EDGES_V" AS
  -- kg:requires edges: concept → concept
  SELECT
    'concept:' || src.slug    AS "SOURCE",
    'concept:' || tgt.slug    AS "TARGET",
    'requires'                AS "EDGE_TYPE"
  FROM "com_sap_developers_ims_ConceptEdges" ce
  JOIN "com_sap_developers_ims_Concepts" src ON src.ID = ce.source_ID
  JOIN "com_sap_developers_ims_Concepts" tgt ON tgt.ID = ce.target_ID
  WHERE ce.predicate = 'requires' AND ce.status = 'ACTIVE'
    AND src.status = 'ACTIVE' AND tgt.status = 'ACTIVE'
  UNION ALL
  -- kg:teaches edges: tutorial → concept
  SELECT
    'tutorial:' || t.slug     AS "SOURCE",
    'concept:' || c.slug      AS "TARGET",
    'teaches'                 AS "EDGE_TYPE"
  FROM "com_sap_developers_ims_TutorialConceptLinks" tcl
  JOIN "com_sap_developers_ims_Tutorials" t ON t.ID = tcl.tutorial_ID
  JOIN "com_sap_developers_ims_Concepts" c   ON c.ID = tcl.concept_ID
  WHERE c.status = 'ACTIVE';
```

Only two edge types (`requires`, `teaches`). The PREREQ arm doesn't need `coCompletedWith`, `relatedTo`, or the other seven predicates — and adding them would inflate the workspace with edges `SHORTEST_PATH` would then have to filter out. If any follow-on issue graduates (PageRank, community detection, WCC), the edge view widens accordingly — tracked in follow-on Issue 4.

### Workspace declaration: `KG_PG_WORKSPACE.hdbgraphworkspace`

```json
{
  "vertexTable":     "KG_PG_VERTICES_V",
  "vertexKeyColumn": "VERTEX_KEY",
  "edgeTable":       "KG_PG_EDGES_V",
  "edgeSourceColumn": "SOURCE",
  "edgeTargetColumn": "TARGET",
  "edgeKeyColumn":   null
}
```

Edges are unkeyed — multiple edges between the same vertex pair fold to one, which is fine for `SHORTEST_PATH` (it cares about existence and hop count, not edge identity).

### What the PREREQ query actually computes

The v1 SPARQL PREREQ arm walks: `<from> kg:teaches ?c1 . ?c1 (^kg:requires)+ ?cN . ?b kg:teaches ?cN`. Translated to vertex-hops on the property graph:

```
tutorial:<from>  --teaches-->  concept:c1
                                    ^
                                    | (^requires) closure — any number of hops
                                    v
                              concept:cN  <--teaches--  tutorial:<b>
```

`SHORTEST_PATH` with an edge-type filter handles this cleanly. The JS layer post-filters paths whose internal vertices aren't concepts (defense in depth against a bad workspace refresh).

**Hop count** = path length − 2 (subtract the two `teaches` edges at the endpoints). This is what the v1 comment says is zero today because SPARQL can't compute it.

## Procedure body

```sql
PROCEDURE KG_PATH_V2 (
  IN  from_iri    NVARCHAR(500),
  IN  to_iri      NVARCHAR(500),
  IN  max_hops    INTEGER,        -- caller-supplied bound; NULL → default 8
  OUT paths       TABLE (
    path_rank    INTEGER,     -- 1..N, cheapest first
    hop_count    INTEGER,     -- edges − 2 (exclude the two `teaches` bookends)
    vertex_seq   NVARCHAR(500),  -- 'concept:<slug>' or 'tutorial:<slug>'
    seq_index    INTEGER      -- 0..hop_count+1 along the path
  )
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  DECLARE KG_INVALID_TUTORIAL_IRI CONDITION FOR SQL_ERROR_CODE 10006;
  DECLARE KG_MAX_HOPS_OUT_OF_RANGE CONDITION FOR SQL_ERROR_CODE 10008;

  DECLARE from_key NVARCHAR(500);
  DECLARE to_key   NVARCHAR(500);
  DECLARE effective_max_hops INTEGER;

  -- Validate IRIs against the same regex used by KG_QUERY.
  IF :from_iri IS NULL OR NOT (:from_iri LIKE_REGEXPR
       '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') OR
     :to_iri IS NULL OR NOT (:to_iri LIKE_REGEXPR
       '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') THEN
    SIGNAL KG_INVALID_TUTORIAL_IRI;
  END IF;

  -- Clamp max_hops to [1, 20]. NULL → 8.
  effective_max_hops := COALESCE(:max_hops, 8);
  IF effective_max_hops < 1 OR effective_max_hops > 20 THEN
    SIGNAL KG_MAX_HOPS_OUT_OF_RANGE;
  END IF;

  -- Derive workspace vertex keys from the IRIs.
  from_key := 'tutorial:' ||
    SUBSTR(:from_iri, LENGTH('https://developers.sap.com/kg/tutorial/') + 1);
  to_key   := 'tutorial:' ||
    SUBSTR(:to_iri,   LENGTH('https://developers.sap.com/kg/tutorial/') + 1);

  -- Body: shortest path in KG_PG_WORKSPACE.
  -- The GraphScript block below is a placeholder. Task 1 of the implementation
  -- plan (spike-within-the-spike) confirms the exact call shape against the
  -- live DB via hana-cli before we lock the procedure body.
  paths = SELECT
            :from_key   AS vertex_seq, 0 AS seq_index,
            1           AS path_rank,  0 AS hop_count
          FROM DUMMY
          WHERE 1 = 0;  -- placeholder: returns empty until Task 1 lands
END;
```

**Two intentional placeholder gaps, addressed as Task 1 of the implementation plan:**

1. **The `SHORTEST_PATH` invocation syntax.** HANA property-graph algorithms are invoked via GraphScript (`CREATE PROCEDURE ... LANGUAGE GRAPH`). The exact call syntax on the QRC that shipped 2026-07-01 needs to be confirmed against the live DB — the [SAP HANA Graph reference](https://help.sap.com/docs/hana-cloud-database) is versioned per QRC and the property-graph transformation feature is new enough that training data does not cover it. Task 1 is a 30-minute probe using `hana-cli` to run a hand-written `SHORTEST_PATH` against a tiny fixture, capturing the exact call shape.

2. **Table-typed OUT parameter.** HANA SQLScript supports `OUT param TABLE(...)` but the calling convention from `cds.db.run` needs verification — the existing DEFINER procedures use scalar OUT parameters (`response NCLOB`). Fallback if table-OUT doesn't cross the boundary cleanly: write path rows into a global temporary table `#KG_PATH_V2_RESULT` and have the JS layer `SELECT` from it — same one-transaction guarantee, uglier boundary. Task 1 confirms.

## JS wrapper

```js
// srv/lib/kg-path-v2-client.js
// Typed wrapper for the KG_PATH_V2 DEFINER procedure. Separate module from
// kg-sparql-client.js because this doesn't speak SPARQL — it calls the HANA
// property-graph engine via a stored procedure over the KG_PG_WORKSPACE
// view-based workspace.
//
// Contract:
//   kgPathV2({ fromIri, toIri, maxHops = 8 })
//     → Promise<Array<{ pathRank, hopCount, vertices: string[] }>>
//
// Error codes surfaced to callers via err.code:
//   10006  KG_INVALID_TUTORIAL_IRI   — IRI regex mismatch (pre-check + DB)
//   10008  KG_MAX_HOPS_OUT_OF_RANGE  — maxHops not in [1, 20]

import cds from '@sap/cds';

const IRI_RX = /^https:\/\/developers\.sap\.com\/kg\/tutorial\/[a-z0-9-]{1,80}$/;

export async function kgPathV2({ fromIri, toIri, maxHops = 8 }) {
  if (!IRI_RX.test(fromIri) || !IRI_RX.test(toIri)) {
    const err = new Error('KG_INVALID_TUTORIAL_IRI');
    err.code = 10006;
    throw err;
  }
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 20) {
    const err = new Error('KG_MAX_HOPS_OUT_OF_RANGE');
    err.code = 10008;
    throw err;
  }

  const rows = await cds.db.run(
    `CALL "KG_PATH_V2"(?, ?, ?, ?)`,
    [fromIri, toIri, maxHops]
  );

  // rows is a flat array of { PATH_RANK, HOP_COUNT, VERTEX_SEQ, SEQ_INDEX }.
  // Group by PATH_RANK; SEQ_INDEX puts vertices in path order per group.
  const byRank = new Map();
  for (const r of rows) {
    let bucket = byRank.get(r.PATH_RANK);
    if (!bucket) {
      bucket = { pathRank: r.PATH_RANK, hopCount: r.HOP_COUNT, vertices: [] };
      byRank.set(r.PATH_RANK, bucket);
    }
    bucket.vertices[r.SEQ_INDEX] = r.VERTEX_SEQ;
  }
  return [...byRank.values()]
    .sort((a, b) => a.pathRank - b.pathRank);
}
```

## Handler edit

The existing `pathBetween` handler in `srv/knowledge-graph-service.js` grows a flag check at the top:

```js
srv.on('pathBetween', async (req) => {
  const { fromSlug, toSlug } = req.data;
  const fromIri = `https://developers.sap.com/kg/tutorial/${fromSlug}`;
  const toIri   = `https://developers.sap.com/kg/tutorial/${toSlug}`;

  // Feature flag: property-graph PREREQ path.
  if (process.env.KG_PATH_V2_ENABLED === 'true') {
    try {
      const paths = await kgPathV2({ fromIri, toIri });
      if (paths.length > 0) {
        // Map property-graph result to the existing wire shape;
        // fall through to CO_COMPLETED / SHARED_CONCEPT arms via
        // the existing SPARQL client if paths.length === 0.
        return mapPgPathsToWireShape(paths);
      }
    } catch (err) {
      // Log and fall through — never let a v2 failure regress v1.
      req.warn('kg_path_v2_failed', { code: err.code, message: err.message });
    }
  }

  // Unchanged v1 path.
  return existingSparqlPathBetween({ fromIri, toIri });
});
```

**Two hardening choices:**

- **Fail-open to v1.** Any v2 error (procedure missing, workspace not built, IRI validation mismatch, DB timeout) logs a warning and falls through to the v1 SPARQL path. The user sees the v1 result.
- **Empty-v2 falls through, doesn't return empty.** If PREREQ has no path but CO_COMPLETED / SHARED_CONCEPT would — we take the v1 result. Preserves the current graceful-fallback UX.

## Feature flag

- Name: `KG_PATH_V2_ENABLED`
- Default: unset (v1 behavior).
- Values: `'true'` enables v2. Any other value keeps v1.
- Set via `cf set-env tutorials-srv KG_PATH_V2_ENABLED true && cf restart tutorials-srv`.
- Rollback: `cf set-env tutorials-srv KG_PATH_V2_ENABLED false && cf restart tutorials-srv`. Procedure and workspace stay deployed but idle.

## Test coverage

**Unit tests** — `test/unit/kg-path-v2-client.test.js` (new file)

- IRI regex rejects `http://` / trailing slash / uppercase / `>80` chars → throws with `err.code === 10006` before any DB call.
- `maxHops` outside `[1, 20]` → throws with `err.code === 10008`.
- Row grouping: given flat `PATH_RANK/SEQ_INDEX` rows, returns correctly ordered `vertices` arrays.
- Grouping is robust to out-of-order rows (DB doesn't guarantee ordering without `ORDER BY`).

**Handler-level unit test** — `test/unit/srv/kg-path-v2-handler-flag.test.js` (new file)

- `KG_PATH_V2_ENABLED=false` → wrapper is never called (spied), v1 path runs.
- `KG_PATH_V2_ENABLED=true` + wrapper returns rows → returns v2-mapped shape.
- `KG_PATH_V2_ENABLED=true` + wrapper returns `[]` → falls through to v1.
- `KG_PATH_V2_ENABLED=true` + wrapper throws → falls through to v1 **and** emits `kg_path_v2_failed` warning.

**Hybrid test** — `test/hybrid/kg-path-v2.test.js` (new file, gated by `ALLOW_HYBRID_WRITES=true` per the write-safety guard)

1. `beforeAll`: seeds a small subgraph using `__TEST__`-prefixed slugs (matching the existing hybrid-test cleanup convention in [test/hybrid/_guard.js](../../../test/hybrid/_guard.js)). Fixture: 4 concepts chained by `kg:requires`, plus 3 tutorials each teaching one concept, plus one "island" tutorial with no path.
2. `kgPathV2({ fromIri, toIri })` on the chained tutorials returns at least one path with `hopCount ≥ 1` and vertex sequence matches the seeded chain.
3. The "island" tutorial returns `[]` (empty — not a throw).
4. Invalid IRI → `err.code === 10006` from the DB, confirming procedure-level validation still fires (not just the JS pre-check).
5. `afterAll`: `DELETE ... WHERE slug LIKE '__TEST__%'`.

**Smoke test:** none for the spike. Adding `pathBetween` to the smoke suite would require test fixtures in production. If the spike graduates, a smoke test is part of the follow-on PR.

**Deliberately out of scope:** performance micro-benchmarks against a hybrid DB. Noisy and misleading. The A/B latency signal comes from live logs during the flag-on window, not tests.

## Observability

Uses the existing metrics module ([srv/lib/metrics.js](../../../srv/lib/metrics.js), from #805). Emitted in the `pathBetween` handler right before returning:

- `counter kg_path_between_calls` with dimensions `{ version: 'v1' | 'v2', outcome: 'success' | 'empty' | 'error', arm: 'prereq' | 'co_completed' | 'shared_concept' | 'none' }`
- `counter kg_path_v2_fallback` with dimension `{ reason: 'error' | 'empty' | 'flag_off' }` — every time v2 was attempted but v1 served the response
- `reservoir kg_path_between_latency_ms` with dimension `{ version: 'v1' | 'v2' }` — p50/p95/p99 over the 5-min rollup window

**Live dashboard:** `/admin-ui/#metrics` renders `MetricSnapshots` and refreshes every 30 s. No new UI. When the flag is on, the tile shows both v1 and v2 series side-by-side — that IS the A/B evidence.

**Manual probe:** `GET /admin/metrics/live` (Admin scope) pulls the last 5-min window as JSON for ad-hoc analysis.

**One log line per fallback.** `req.warn('kg_path_v2_failed', { code, message, fromSlug, toSlug })` — greppable in `cf logs` and hits the audit log. If we see this at >1% of calls, that's a spike-defining failure signal.

**No new tables.** Everything rides on existing `MetricSnapshots` / `PipelineLog` infrastructure.

## Rollback drill

Before declaring the spike "on":

1. `cf set-env tutorials-srv KG_PATH_V2_ENABLED true && cf restart tutorials-srv`.
2. Confirm v2 metrics appear in `/admin-ui/#metrics` within 5 minutes.
3. `cf set-env tutorials-srv KG_PATH_V2_ENABLED false && cf restart tutorials-srv`.
4. Confirm v2 metrics stop appearing and v1 numbers match pre-flag baseline.

If step 4 doesn't hold, the flag doesn't gate cleanly and we fix that before opening it up.

## Decision gate

The gate is a **qualitative team review** at end of week, not a numeric hurdle. But the review meeting must have the right evidence in front of it — the spike commits to producing this artifact:

`docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-review.md` covering:

1. **What we shipped** — links to the merged PR(s), the deployed procedure, the workspace.
2. **Was v2 measurably better on `pathBetween`?** — screenshot of `/admin-ui/#metrics` showing v1 vs v2 latency reservoirs and success/empty/error counters over the flag-on window. Concrete numbers.
3. **Did anything break?** — count of `kg_path_v2_failed` fallbacks, cited log lines, any user-visible incident.
4. **Developer-experience read** — how much friction was the property-graph learning curve? Would the team be comfortable authoring another algorithm procedure without hand-holding?
5. **The follow-on question** — for each of the four candidate follow-on issues (below), a one-paragraph "yes / no / needs-more-thought" from the team.

The review meeting outputs a decision on **each** follow-on independently.

## Follow-on issues

Filed alongside this spec merging, cross-referencing it. Each is a stub — the design work happens later if the team elects to work them.

- **Issue: KG PageRank for whatToLearnNext ranking.** Replaces hardcoded per-arm weights in [KG_QUERY.hdbprocedure:143](../../../db/src/procedures/KG_QUERY.hdbprocedure#L143) with data-driven scores from a nightly PageRank pass over `KG_PG_WORKSPACE` (widened to include `coCompletedWith`).
- **Issue: KG community detection → auto-suggested completion paths.** Louvain / label-propagation over `KG_PG_WORKSPACE` surfaces natural clusters the admin UI can suggest as missions/groups.
- **Issue: KG weakly-connected components as a curation quality signal.** Any concept or tutorial in a WCC of size 1 is a curation gap; nightly WCC pass, `@readonly` service-layer projection exposes an isolation flag, admin UI shows a badge.
- **Issue: Widen `KG_PG_WORKSPACE` to full 9-predicate parity with the RDF graph.** Prerequisite for any of the three follow-ons above at full fidelity. Design question: do view-based edges perform at that width, or do we need materialized tables?

## Non-goals

- **Not** replacing SPARQL as the primary KG query language. SPARQL and property-graph queries are complementary; the property graph adds algorithmic capabilities SPARQL can't express.
- **Not** touching the RDF graph rebuild path ([srv/lib/kg-graph-rebuild.js](../../../srv/lib/kg-graph-rebuild.js)).
- **Not** exposing property-graph queries to the admin `runSparql` action or the Joule chat tools. The wrapper is server-internal for the spike.
- **Not** materializing vertex/edge tables. Views only for the spike.
- **Not** widening the workspace beyond `requires` + `teaches`. That's follow-on Issue 4.
- **Not** shipping a smoke test for the spike.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `SHORTEST_PATH` call syntax on the deployed QRC differs from what training data suggests. | Task 1 of the plan probes the live DB via `hana-cli` before the procedure body is finalized. |
| Table-typed OUT parameter doesn't cross the `cds.db.run` boundary cleanly. | Fallback to a global temporary table pattern; confirmed in Task 1. |
| View-based workspace is too slow for `SHORTEST_PATH` at production graph size. | The spike measures this. If slow, the review-artifact numbers surface it; follow-on Issue 4 already anticipates the materialized-table alternative. |
| Per-workspace ACL (if HANA applies one) locks the workspace to whichever runtime user first touches it, mirroring the [#533](https://github.com/sap-tutorials/tutorials-ims/pull/533) SPARQL issue. | DEFINER procedure pattern already mitigates this — the procedure body runs as `#OO`, the stable object-owner identity. |
| Property-graph feature is entitled but a specific privilege (e.g. `GRAPH USAGE`) is missing on the runtime user. | Task 1 verifies `hana-cli status --priv` before writing any procedure code. If missing, the spike stalls on a service-key update rather than on code. |
| The one-week timebox is optimistic. | The spike is scoped to fail cleanly: at worst we ship the workspace + procedure with a placeholder body and a review-artifact that says "the syntax spike took longer than expected — no v2 code path reached DEV." That IS the answer if it happens. |
