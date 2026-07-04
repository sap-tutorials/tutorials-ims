# Task 0 notes — #916 KG PageRank probe

**Date:** 2026-07-04
**Probing against:** DEV HANA Cloud (via `hana-cli`, MTA deploy for GraphScript)
**Worktree:** `worktree-issue-916-kg-pagerank`

---

## 0.1 — Prereq #919 (KG_PG_EDGES_V widening)

**Status: ✅ deployed on DEV** as of Tom's ~13:30 UTC MTA deploy on 2026-07-04.

```
Entity KG_PG_EDGES_V {
    EDGE_KEY: String(600)      -- widened from 400 (pre-#919)
    SOURCE: String(280)
    TARGET: String(280)
    EDGE_TYPE: String(15) not null
}
```

Deployed `EDGE_TYPE` values present today (edge counts):

| EDGE_TYPE        | N     |
| ---------------- | ----- |
| coCompletedWith  | 20496 |
| extends          | 45    |
| partOf           | 640   |
| requires         | 3233  |
| taggedWith       | 11267 |
| teaches          | 4393  |

`relatedTo`, `aboutProduct`, `inCategory` are declared in `KG_PG_EDGES_V.hdbview`
but have zero source rows (no `ConceptEdges.predicate = 'relatedTo'` in DB;
no tags with `software-product>` prefix; no missions bound to categories via
the seeded schema). Not a blocker for #916 — `coCompletedWith` is the arm
whatToLearnNext needs.

Deployed `VERTEX_TYPE` values (vertex counts):

| VERTEX_TYPE | N    |
| ----------- | ---- |
| category    | 8    |
| concept     | 5282 |
| group       | 359  |
| mission     | 888  |
| tag         | 9696 |
| tutorial    | 781  |

`product` declared, zero rows (same reason as `aboutProduct`).

---

## 0.2 — Workspace scale

- **Vertices total: 17,014** (dominated by `tag` 9696, `concept` 5282)
- **Edges total: 40,074** (dominated by `coCompletedWith` 20496, `taggedWith` 11267)

**Impact on Task 7 wall-clock ceiling:** the plan estimated <60s at "prod scale"
based on an assumed ~6k vertices / ~7-10k edges. Actual DEV scale is ~3x/4x
larger. Ceiling should be widened to **<120s** for the p95 gate. If PageRank
proves to be manual GraphScript (see 0.3 below), the ceiling may need to be
much larger — Closeness_Centrality is O(V·(V+E)) in the reference custom
implementation.

---

## 0.3 — PageRank primitive probe (CRITICAL FINDING)

**Attempted probe:** `_KGPROBE_PAGERANK.hdbprocedure` deployed via `mbt build`
+ `cf deploy -m tutorials-db-deployer` on `mtar_archives/tutorials-ims_1.0.0.mtar`.

Probe body:

```sql
PROCEDURE _KGPROBE_PAGERANK (OUT o_rows TABLE (vertex_key NVARCHAR(280), score DOUBLE))
LANGUAGE GRAPH READS SQL DATA AS
BEGIN
  GRAPH g = Graph("KG_PG_WORKSPACE");
  MAP<Vertex, DOUBLE> pr = PAGE_RANK(:g);
  o_rows = SELECT :v."VERTEX_KEY", :pr[:v]
           FOREACH v IN Vertices(:g)
           WHERE :v."VERTEX_TYPE" = 'concept';
END;
```

**Deploy failed at HDI precompile:**

```
at "src/procedures/_KGPROBE_PAGERANK.hdbprocedure" (27:35)
Error: com.sap.hana.di.procedure: Syntax error:
  "exception 73002201: syntax error, unexpected =, expecting ; near "="" [8250009]
```

Line 27 col 35 = the `=` in `MAP<Vertex, DOUBLE> pr = PAGE_RANK(:g)`.

### Root-cause diagnosis: PageRank is NOT a HANA GraphScript built-in

Enumerated the full list of built-in algorithms shipped by SAP as example SQL
in [SAP-samples/hana-graph-examples](https://github.com/SAP-samples/hana-graph-examples)
under `GRAPH_PROCEDURE_EXAMPLES/BUILTIN_FUNCTIONS_ALGORITHMS/`:

- Breadth_First_Search
- Depth_First_Search
- Shortest_Path_One_to_One (used by our KG_SHORTEST_PATH_GRAPH)
- Shortest_Path_One_to_All
- Dijkstra
- Max_Flow (moved from CUSTOM to BUILTIN in 2025Q2)
- Neighbors
- Top_k_Shortest_Paths
- Strongly_Connected_Components
- Communities_Louvain

**No PageRank.** No `PAGE_RANK`, no `Compute_PageRank`, no `PageRank`. All three
spellings the plan speculated about do not exist in HANA GraphScript.

For comparison, algorithms in `CUSTOM_ALGORITHMS/` — meaning **user-written
GraphScript**, not built-in — include:

- Closeness_Centrality
- Connected_Components
- Triangle_Counting
- Topological_Sort
- (PageRank is not even here — SAP has never published a reference GraphScript
  PageRank implementation.)

Reference custom-algorithm pattern (from Closeness_Centrality):

```sql
FOREACH v_start IN Vertices(:g) {
  -- manual per-vertex traversal + score accumulation
  TRAVERSE BFS (:i_dir) :g FROM :v_start ON VISIT VERTEX (Vertex v_visited, BIGINT lvl) {
    -- accumulate into local BIGINT / DOUBLE state
  };
  o_res."ID"[:v_i] = :v_start."ID";
  o_res."SCORE"[:v_i] = ...;
  v_i = :v_i + 1L;
}
```

There is no `MAP<Vertex, DOUBLE>` type in GraphScript. Per-vertex results are
either (a) written directly to indexed OUT-table columns, or (b) captured via
`FIXED_TABLE<...>` local variables. The plan's Task 2 template referenced
`MAP<Vertex, DOUBLE>` as if borrowing from Pregel or Neo4j Cypher syntax —
that mental model doesn't apply to HANA GraphScript.

### Design implications

The plan is not implementable as written. Three real options:

**Option A: Write PageRank in GraphScript from scratch.** Manual iteration
loop implementing `PR(v) = (1-d)/N + d × Σ (PR(u)/L(u))` for u in neighbors(v).
Convergence via a fixed-iteration count (e.g. 30) or delta threshold.
Complexity: ~50-80 lines of GraphScript. Wall-clock risk: iterative on 17k
vertices / 40k edges = tens of seconds per iteration in the worst case;
30 iterations could push into minutes. Beyond nightly-job design headroom.

**Option B: PageRank in SQLScript over the edge table.** Iterative fixed-point
computation using UPDATE statements. Simpler than custom GraphScript, but
still O(iterations × edges) per pass; probably 30-120s at DEV scale.

**Option C: PageRank in the Node.js job body.** Read edges from KG_PG_EDGES_V
into memory (40k rows, <5MB), run PageRank locally (a well-optimized JS
implementation is 5-15 seconds at this scale), write results back via
INSERT batch. Simplest to implement, easiest to test, easiest to iterate on
the algorithm (damping, weighting, personalization). Trade-off: takes memory
and CPU on the CAP srv instance instead of on HANA.

**Option D: Approximate PageRank via SQL-only aggregate.** Simple heuristics
(weighted in-degree, or in-degree × avg-source-in-degree) capture ~70% of the
signal at negligible cost. Not "true" PageRank but may be adequate for the
`whatToLearnNext` blend that only uses relative ordering.

Recommend: **discuss with Tom.** The plan's Q2 "HANA GraphScript PageRank in
a new KG_PAGERANK.hdbprocedure (sibling of KG_SHORTEST_PATH_GRAPH)" needs a
material revision to one of A / B / C / D above.

### Confirmed on positive side

- Sidecar tables `COM_SAP_DEVELOPERS_IMS_CONCEPTRANK` and `COM_SAP_DEVELOPERS_IMS_TUTORIALRANK`
  precompiled cleanly (see deployer log). Task 1 is unblocked once the compute
  design is chosen.
- The MTA build + `-m tutorials-db-deployer` module-targeted deploy flow works
  (after the credstore migration, no envsubst step needed).
- `dev.mtaext` is envsubst-free (post-#980) — CLAUDE.md gotcha "Local deploy
  is envsubst-free" is current.

---

## 0.4 — Next step

**Plan is BLOCKED at Task 0.3.** The rest of the plan (Tasks 1-9) assumes a
GraphScript primitive that doesn't exist. Need a design decision on A/B/C/D
before rewriting Task 2 (the procedure), which in turn ripples into Task 4
(nightly job), Task 6 (hybrid test), and possibly Task 9 (wall-clock ceiling).

Task 1 (sidecar tables) is delivered on DEV and safe to leave — they hold zero
rows until the chosen compute path lands.
