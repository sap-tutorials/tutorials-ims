# KG: weakly-connected components as curation quality signal — Design

**Issue:** [#918](https://github.com/sap-tutorials/tutorials-ims/issues/918)
**Prereq:** [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919) (widened `KG_PG_WORKSPACE` to 9-predicate parity) — merged 2026-07-04.
**Parent spike:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913), design in [`2026-07-02-913-kg-property-graph-spike-design.md`](2026-07-02-913-kg-property-graph-spike-design.md), gate graduated 2026-07-04.
**Sibling precedents:**
- [#916 PageRank](2026-07-04-916-kg-pagerank-design.md) — landed 2026-07-04 (commits 187e2b49, 6a715d0f). Templates the "nightly cron → sidecar table → Node.js compute" shape reused here.
- [#917 Louvain communities](2026-07-04-917-kg-community-detection-design.md) — spec landed 2026-07-04 (commit 0bf31172). Templates the vertex-type discriminator + `@readonly` admin projection shape.

**Scope:** DEV-only in v1. PROD rollout is out of scope.
**Date:** 2026-07-04

## Problem

Any concept or tutorial in a **weakly-connected component of size 1** (or, per Q4, a small island of size ≤ threshold) is a curation gap — no shared concept, no prerequisite relationship, no co-completion signal, no tutorial that teaches it. Today there's no way to spot these except by manually browsing `/explore`, which renders isolated nodes as floating dots but doesn't flag them as problems. As the graph grows past ~800 tutorials and ~6k concepts, the isolated-vertex tail grows too, and hand-spotting stops scaling.

## Proposal

A nightly weakly-connected-components (WCC) pass over `KG_PG_WORKSPACE` (the full 9-predicate graph, post-#919) assigns each vertex a component ID and a component size. Concept and tutorial vertices whose component size ≤ `KG_WCC_ISOLATION_THRESHOLD` (default `1`) are materialized into a single sidecar table `KgIsolation`. The admin Concepts and Tutorials List Reports surface an "Isolated" badge on those rows, prompting the curator to add a `teaches` link, a `requires` edge, or a `coCompletedWith` grouping. Visitor surfaces are untouched.

## Design decisions (locked during brainstorm 2026-07-04)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| Q1 | Compute engine | **Node.js union-find** in `srv/jobs/kg-wcc-job.js` | HANA GraphScript builtins (per the #916 Task 0 probe) include `Strongly_Connected_Components` but **not** weakly-connected-components. Reusing SCC on doubled edges would need a wrapper view or a materialized reverse-edge fan-out; a Node.js union-find with path compression + union by rank is ~30 lines, matches the #916 precedent verbatim, and reads the same `KG_PG_VERTICES_V` / `KG_PG_EDGES_V` rows the PageRank job already pulls. |
| Q2 | Vertex scope for the isolation flag | **Concepts + Tutorials only** | Matches the issue's problem statement verbatim ("Any concept or tutorial in a WCC of size 1 is a curation gap"). The WCC pass sees all seven vertex types in the workspace, but tag/product/category/mission/group isolations aren't actionable in the same way — an isolated tag means "used on one tutorial," which is not a bug. Widening scope now adds three admin badges + projections without a customer. |
| Q3 | Storage shape | **Single sidecar `KgIsolation`** with `(vertexType, slug)` composite key + `componentId` + `componentSize` + `computedAt`. `@cds.autoexpose: false`. Not `managed`. Surfaced to the admin via a **virtual `isolated : Boolean`** element on `KnowledgeGraphService.Concepts` and `AdminService.Tutorials`, populated by an `on(READ)` decorator (or by an inline `EXISTS` / `LEFT JOIN` — implementation-plan detail). | Adding `isolationFlag` directly to `Concepts` / `Tutorials` (issue's option A) would (a) fire `@Capabilities.ChangeTracking` + `managed` timestamp updates on every unchanged row every night, poisoning the audit trail; (b) require a schema migration on two heavily-referenced entities. A single sidecar keyed by `(vertexType, slug)` is cleaner than #916's two-table split because we're materializing **one** signal, not two independent score dimensions. |
| Q4 | Definition of "isolated" | **Configurable size-N threshold** via env var `KG_WCC_ISOLATION_THRESHOLD`, default `1` | The issue text says "size-1 component get flagged," but a tutorial-teaches-concept pair where nothing else touches either is a size-2 component that is still a curation gap. Storing `componentSize` on `KgIsolation` and materializing rows for every vertex where `componentSize ≤ threshold` future-proofs the tuning knob: bumping to 2 or 3 later is `cf set-env`, not a schema+job change. Default `1` keeps day-one behavior identical to the issue text. |
| Q5 | Schedule | **Daily 04:07 UTC** | Runs after PageRank (03:53) and after the planned Louvain slot (03:57), so all three algorithms operate on the same nightly snapshot of `KG_PG_WORKSPACE`. `04:07` is unused (verified against `srv/jobs/scheduler.js`) and follows the "avoid `:00`/`:30` thundering herd" convention. |
| Q6 | Feature flag | **No runtime kill-switch**. The nightly job always runs; the badge always renders when `KgIsolation` has a row. | Unlike PageRank (which mutates ranker output on the visitor path) and Louvain (which surfaces a whole new admin tile), this signal is a single boolean cell on two existing LRs. If curators find it noisy, `KG_WCC_ISOLATION_THRESHOLD=0` empties the table on the next nightly run, or the `registerJob` block can be commented out. Env-flagged conditional rendering on a single column is more scaffolding than it saves. |
| Q7 | Test scope | **Unit test on the pure `computeWcc(vertices, edges)` function** + **hybrid test** with a fixture of one isolated concept + one isolated tutorial + one connected pair. Follows the #916 split (`test/unit/kg-pagerank-compute.test.js` + `test/hybrid/kg-pagerank.test.js`). | Union-find is trivially testable in isolation; hybrid verifies the DB round-trip and the admin projection sees the virtual field. |

## Architecture

```text
Nightly cron (04:07 UTC)              Admin-read time
─────────────────────────             ─────────────────
scheduler.registerJob                  GET /admin/Concepts?$select=...,isolated
  └─ kg-wcc-job.js                     GET /admin/Tutorials?$select=...,isolated
       │                                     │
       ├─ SELECT VERTEX_KEY, VERTEX_TYPE,     ├─ CAP handler
       │  SLUG FROM KG_PG_VERTICES_V          │   fills virtual `isolated`
       ├─ SELECT SOURCE, TARGET               │   from KgIsolation
       │  FROM KG_PG_EDGES_V                  │   (LEFT JOIN or EXISTS)
       ├─ union-find over the edge list       │
       │   (path compression + union          └─ Fiori LineItem cell:
       │    by rank; treats edges as              red badge when
       │    undirected)                           isolated=true
       ├─ count vertices per component root
       ├─ filter to (vertexType IN ('concept',
       │  'tutorial') AND componentSize
       │  ≤ threshold)
       ├─ TRUNCATE + INSERT KgIsolation
       │  in one db.tx
       └─ metrics.gauge('kg_wcc_isolated_count')
         metrics.gauge('kg_wcc_component_count')
         metrics.observe('kg_wcc_duration_ms')
```

Two independent pieces communicating through one sidecar table. Both `Concepts` and `Tutorials` project a virtual `isolated` element that resolves to `true` iff a matching `KgIsolation` row exists. Fail-quiet: an empty `KgIsolation` (fresh DB, first-run gap, or job error) yields `isolated=false` everywhere — safe default.

## Data model

New file `db/knowledge-graph-isolation.cds` (kept out of the main KG file for scoping — same convention #917 used for `knowledge-graph-communities.cds`):

```cds
using { com.sap.developers.ims } from './knowledge-graph';

namespace com.sap.developers.ims;

/**
 * KgIsolation — sidecar flag for concepts/tutorials in small WCCs.
 *
 * Populated nightly by srv/jobs/kg-wcc-job.js at 04:07 UTC. One row per
 * flagged vertex: (vertexType, slug) is the composite PK. componentId is
 * the union-find root vertex-key (opaque; not stable across runs — the
 * union-find picks whatever root emerges from the merge order). componentSize
 * is the count of vertices in that component. Rows only exist when
 * componentSize ≤ KG_WCC_ISOLATION_THRESHOLD (default 1).
 *
 * Not `managed` — nightly TRUNCATE+INSERT overwrite semantics; managed
 * timestamps would be trigger noise on a rebuilt-from-scratch aggregate.
 *
 * @cds.autoexpose: false — never a top-level OData collection; reached
 * only through the `isolated` virtual on Concepts/Tutorials projections.
 *
 * Slug widths mirror source entities:
 *   Concepts.slug  = String(80)
 *   Tutorials.slug = String(255)
 * String(255) covers both.
 */
@cds.autoexpose: false
entity KgIsolation {
  key vertexType    : String(16);   // 'concept' | 'tutorial'
  key slug          : String(255);
      componentId   : String(280);  // KG_PG_VERTICES_V.VERTEX_KEY of the union-find root
      componentSize : Integer;
      computedAt    : Timestamp;
}
```

### HANA table name

`COM_SAP_DEVELOPERS_IMS_KGISOLATION` — referenced as a string constant in the job, matching the raw-SQL convention `kg-pagerank-job.js` established for `COM_SAP_DEVELOPERS_IMS_CONCEPTRANK`.

## The compute (Node.js union-find)

New `srv/jobs/kg-wcc-job.js`. Structure copies `kg-pagerank-job.js` verbatim (pure-function core + DB-integrated entry point + LOG + metrics + fail-open):

```js
// Pure core — exposed for unit tests. No DB, no cds.
export function computeWcc(vertices, edges) {
  const N = vertices.length;
  const indexOf = new Map();
  for (let i = 0; i < N; i++) indexOf.set(vertices[i], i);

  const parent = new Int32Array(N);
  const rank   = new Int8Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;

  function find(x) {
    // Path compression.
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // Union by rank.
    if (rank[ra] < rank[rb])       parent[ra] = rb;
    else if (rank[ra] > rank[rb])  parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  }

  for (const [src, dst] of edges) {
    const i = indexOf.get(src), j = indexOf.get(dst);
    if (i === undefined || j === undefined) continue;  // orphan edge
    if (i === j) continue;                             // self-loop
    union(i, j);
  }

  // For every vertex, compact-find its root, then count roots.
  const rootOf = new Int32Array(N);
  const sizeByRoot = new Map();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    rootOf[i] = r;
    sizeByRoot.set(r, (sizeByRoot.get(r) || 0) + 1);
  }

  // Materialize a per-vertex result. Callers filter to what they want.
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const r = rootOf[i];
    out[i] = {
      vertexKey:     vertices[i],
      componentId:   vertices[r],
      componentSize: sizeByRoot.get(r),
    };
  }
  return { components: out, componentCount: sizeByRoot.size };
}

export async function runKgWcc() {
  const threshold = Math.max(0,
    Number.parseInt(process.env.KG_WCC_ISOLATION_THRESHOLD ?? '1', 10) || 1);
  const started = Date.now();
  const db = await cds.connect.to('db');

  try {
    const vertexRows = await db.run(
      'SELECT VERTEX_KEY, VERTEX_TYPE, SLUG FROM KG_PG_VERTICES_V');
    const edgeRows = await db.run(
      'SELECT "SOURCE", "TARGET" FROM KG_PG_EDGES_V');
    const readMs = Date.now() - started;

    const vertexKeys = vertexRows.map(r => r.VERTEX_KEY);
    const edges = edgeRows.map(r => [r.SOURCE, r.TARGET]);
    const t1 = Date.now();
    const { components, componentCount } = computeWcc(vertexKeys, edges);
    const computeMs = Date.now() - t1;

    // Zip compute results back to (vertexType, slug) for filtering, then
    // materialize rows only for concept/tutorial vertices in small components.
    const now = new Date().toISOString();
    const toInsert = [];
    for (let i = 0; i < vertexRows.length; i++) {
      const v = vertexRows[i];
      const c = components[i];
      if (!v.SLUG) continue;
      if (v.VERTEX_TYPE !== 'concept' && v.VERTEX_TYPE !== 'tutorial') continue;
      if (c.componentSize > threshold) continue;
      toInsert.push({
        vertexType:    v.VERTEX_TYPE,
        slug:          v.SLUG,
        componentId:   c.componentId,
        componentSize: c.componentSize,
        computedAt:    now,
      });
    }

    const t2 = Date.now();
    const INSERT_SQL =
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_KGISOLATION"
         (VERTEXTYPE, SLUG, COMPONENTID, COMPONENTSIZE, COMPUTEDAT)
         VALUES (?, ?, ?, ?, ?)`;
    await db.tx(async tx => {
      await tx.run(`TRUNCATE TABLE "COM_SAP_DEVELOPERS_IMS_KGISOLATION"`);
      for (let i = 0; i < toInsert.length; i += 500) {
        const batch = toInsert.slice(i, i + 500);
        await tx.run(
          INSERT_SQL,
          batch.map(r => [r.vertexType, r.slug, r.componentId, r.componentSize, r.computedAt]),
        );
      }
    });
    const writeMs = Date.now() - t2;

    metrics.observe('kg_wcc_duration_ms', Date.now() - started);
    metrics.gauge('kg_wcc_component_count', componentCount);
    metrics.gauge('kg_wcc_isolated_count', toInsert.length);
    LOG.info(
      `WCC: ${vertexKeys.length} vertices / ${edges.length} edges → ` +
      `${componentCount} components, ${toInsert.length} isolated ` +
      `(threshold=${threshold}, read=${readMs}ms, compute=${computeMs}ms, ` +
      `write=${writeMs}ms)`);
    return { componentCount, isolatedCount: toInsert.length };
  } catch (err) {
    metrics.counter('kg_wcc_failures');
    LOG.error('WCC job failed', err);
    throw err;
  }
}
```

**Raw parameterized `INSERT` (not `INSERT.into(KgIsolation).entries`)** — matches the invocation-path-independence fix from commit `6a715d0f` (#916 PR follow-up): the job may be triggered via `cf run-task ... node -e` where `cds.entities()` is undefined; raw HANA table names work identically from the cron path and task path.

## Scheduler registration

New block in `srv/jobs/scheduler.js`, alongside `kg-pagerank` and the planned `kg-communities`:

```js
import { runKgWcc } from './kg-wcc-job.js';

// ... inside registerJobs():
registerJob({
  jobName: 'kg-wcc',
  schedule: '7 4 * * *',
  ttlMs: 600_000,
  description:
    'Weakly-connected components over KG_PG_WORKSPACE — populates KgIsolation sidecar (#918)',
  fn: () => runKgWcc(),
});
```

Schedule slot audit (verified against `srv/jobs/scheduler.js` at HEAD 0bf31172): `04:07 UTC daily` is unused. Neighboring 04:xx slots taken by `email-retry` (00:xx daily every 4h) at `04:00`, `04:11`, `04:17`, `04:23`, `04:33`, `04:43`, and Mon/Thu `04:31`.

## Service-layer projections

Two projections gain a virtual `isolated : Boolean` element:

**`srv/knowledge-graph-service.cds`** — extend the existing `Concepts` projection (line 58):

```cds
entity Concepts as projection on ims.Concepts excluding { embedding } {
  *,
  virtual null as isolated : Boolean,  // populated by on(READ) decorator; #918
};
```

**`srv/admin-service.cds`** — extend the existing `Tutorials` projection (line 28):

```cds
entity Tutorials as projection on ims.Tutorials {
  *,
  // ... existing fields ...
  virtual null as isolated : Boolean,  // populated by on(READ) decorator; #918
  // ... existing author.* flattened fields ...
};
```

**Populated by `on(READ)` decorator** in `srv/knowledge-graph-service.js` and `srv/admin-service.js` respectively. Handler pattern (in each service):

```js
srv.after('READ', 'Concepts', async (rows, req) => {
  if (!Array.isArray(rows) || !rows.length) return;
  const slugs = rows.map(r => r.slug).filter(Boolean);
  if (!slugs.length) return;
  const flagged = await cds.tx(req).run(
    'SELECT SLUG FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ' +
    'WHERE VERTEXTYPE = ? AND SLUG IN (' + slugs.map(() => '?').join(',') + ')',
    ['concept', ...slugs]);
  const set = new Set(flagged.map(r => r.SLUG));
  for (const r of rows) r.isolated = set.has(r.slug);
});
```

Same shape on `AdminService.Tutorials` with `VERTEXTYPE = 'tutorial'`. Reads are batched per page — Fiori Elements requests 30 rows/page by default, so one small `IN (...)` query per list-report page.

**Fail-quiet**: if the SELECT throws (deploy skew, table missing, HANA hiccup), the handler swallows the error, logs a warning, and leaves `isolated` as the projection default (`null`). Fiori Elements renders `null` boolean as no badge — same as `false`. Wrapped in a `try/catch` in the handler; no request-time throw ever propagates to the client.

## Admin UI (LineItem badge)

Two annotation blocks in `app/admin-annotations.cds`, appended to the existing `annotate` blocks.

**Concepts LR** — extend `annotate KnowledgeGraphService.Concepts with @( ... UI.LineItem: [ ... ] )`. Add a new `DataFieldForAnnotation` cell that renders `isolated=true` as a red criticality badge, using the OData V4 `Criticality` pattern already established at `app/admin-annotations.cds:2537` for the `publishedAt` cell:

```cds
{
  $Type: 'UI.DataField',
  Value: isolated,
  Label: 'Isolated',
  Criticality: { $edmJson: { $If: [ { $Path: 'isolated' }, 1, 0 ] } }
},
```

OData V4 CriticalityType: `0`=Neutral, `1`=Negative (red), `2`=Critical (yellow), `3`=Positive (green). `isolated=true` → red badge; `isolated=false`/`null` → neutral (no badge).

**Tutorials LR** — same annotation appended to `annotate AdminService.Tutorials with @UI.LineItem`. Same criticality expression.

**Property label**:

```cds
annotate KnowledgeGraphService.Concepts with {
  isolated @Common.Label: 'Isolated'
           @Common.FieldControl: #ReadOnly;
};
annotate AdminService.Tutorials with {
  isolated @Common.Label: 'Isolated'
           @Common.FieldControl: #ReadOnly;
};
```

**SelectionFields** (filter bar): add `isolated` to both LRs' `UI.SelectionFields` array so curators can filter to "show only isolated." Filter-by-boolean is a standard FE affordance.

**No shell wiring, no new component, no new route.** The badge lives inside the existing Concepts and Tutorials LRs, both already routed under `/admin-ui/`.

## Testing

**Unit test** — `test/unit/kg-wcc-compute.test.js`. Follows the shape of `test/unit/kg-pagerank-compute.test.js`. Three deterministic fixtures:

1. **All-isolated** (3 vertices, 0 edges): `computeWcc(['a','b','c'], [])` returns `componentCount=3`, every `componentSize=1`.
2. **Two components** (5 vertices, 3 edges: `a-b`, `b-c`, `d-e`): `componentCount=2`, `{a,b,c}` share a component of size 3, `{d,e}` share a component of size 2, `f` (if seeded) size 1.
3. **Directed-edges-treated-undirected** (3 vertices, 2 edges: `a→b`, `c→b`): all three land in one component of size 3. Guards against a future refactor that adds direction-awareness.
4. **Self-loop + orphan edge robustness**: `a-a` (self-loop) leaves `a` as its own component of size 1; edge `[a, 'nonexistent']` is skipped. Matches the sanitization contract of `kg-pagerank-job.js:127-141`.

**Hybrid test** — `test/hybrid/kg-wcc.test.js`. Follows `test/hybrid/kg-pagerank.test.js`.

- Prefix: `__test__kg-wcc-<runId>-`, `runId` from `crypto.randomBytes(3)`.
- Guard: `ALLOW_HYBRID_WRITES=true` via `_guard.js`.
- Fixture (FK-safe INSERT order):
  - `Concepts`: `iso-concept` (no edges), `hub-concept-A`, `hub-concept-B` (linked by `requires` to each other).
  - `Tutorials`: `iso-tutorial` (no `teaches`, no `taggedWith`, no `coCompletedWith`), `hub-tutorial-A` (teaches `hub-concept-A`), `hub-tutorial-B` (teaches `hub-concept-B`).
  - `ConceptEdges`: `hub-concept-A --requires--> hub-concept-B` (STATUS=ACTIVE).
  - `TutorialConceptLinks`: `hub-tutorial-A --teaches--> hub-concept-A`, `hub-tutorial-B --teaches--> hub-concept-B`.
- `runKgWcc()` invoked directly with `KG_WCC_ISOLATION_THRESHOLD=1`.
- Assertions:
  1. `SELECT * FROM KgIsolation WHERE SLUG LIKE '__test__kg-wcc-<runId>-%'` returns exactly 2 rows: one for `iso-concept` (vertexType='concept'), one for `iso-tutorial` (vertexType='tutorial').
  2. Both rows have `componentSize = 1`.
  3. The four hub-* rows are NOT in `KgIsolation` (they're all in one component of size 4 via the `requires` edge and two `teaches` edges).
  4. Re-run with `KG_WCC_ISOLATION_THRESHOLD=4`: now all six fixture vertices are flagged (hub cluster is size 4 ≤ 4; isolated pair is size 1 ≤ 4).
  5. `GET /admin/Tutorials?$filter=slug eq '__test__kg-wcc-<runId>-iso-tutorial'&$select=slug,isolated` returns `isolated: true`.
  6. `GET /graph/Concepts?$filter=slug eq '__test__kg-wcc-<runId>-iso-concept'&$select=slug,isolated` returns `isolated: true`.
- `afterAll` FK-safe cleanup: TutorialConceptLinks → ConceptEdges → Tutorials → Concepts. `KgIsolation` cleaned by the `LIKE '__test__kg-wcc-<runId>-%'` filter.

### Not tested in v1

- Manual scheduler invocation path (`AdminService.JobControls.runJob('kg-wcc')`) — same chassis as PageRank, already covered by scheduler-chassis tests.
- Criticality color of the badge — a FE annotation concern; verified visually during DEV smoke.

## Environment variables

| Name | Type | Default | Effect |
|---|---|---|---|
| `KG_WCC_ISOLATION_THRESHOLD` | integer string | `'1'` | Vertices in a component of size ≤ threshold are materialized to `KgIsolation`. `0` empties the table (effectively disables the badge). Parsed via `parseInt(...) || 1`, so garbage values fall back to `1` — no crash. |

No runtime kill-switch flag (per Q6). To disable: set `KG_WCC_ISOLATION_THRESHOLD=0` and wait for the next nightly run, or comment out the `registerJob('kg-wcc')` block and redeploy.

## Metrics

| Name | Kind | Description |
|---|---|---|
| `kg_wcc_duration_ms` | observe (reservoir) | Wall-clock of the nightly job. |
| `kg_wcc_component_count` | gauge | Total distinct components in the workspace after the run. |
| `kg_wcc_isolated_count` | gauge | Rows written to `KgIsolation` (concept + tutorial, componentSize ≤ threshold). |
| `kg_wcc_failures` | counter | Nightly job caught-exception increments. |

All surface to `MetricSnapshots` via `srv/jobs/metrics-rollup-job.js` and are viewable at `/admin-ui/#metrics`.

## Error handling & rollback

### Job-level failures

- **Zero-vertex workspace** (fresh DB): union-find returns `{componentCount: 0, components: []}` → 0 rows inserted → tables end empty → readers see `isolated=null` (no badges). Not an error.
- **HANA hiccup mid-batch**: `db.tx` rolls back; yesterday's `KgIsolation` snapshot stays live. `kg_wcc_failures` counter increments; scheduler logs to `PipelineLog` with `status: 'FAILED'`.
- **Job overrun**: `ttlMs = 600000` (10 min). Expected wall-clock at prod scale (~17k vertices, ~40k edges post-#919) is well under 1s (union-find is `O(N + M · α(N))`). 10-min ceiling is loud headroom.

### Request-time failures

- **`KgIsolation` SELECT throws** (deploy skew, table missing): the `after('READ')` handler catches the error, logs a warning, leaves `isolated` unset. Fiori renders no badge. Never propagates to the client.
- **`KgIsolation` empty**: `IN (...)` returns no rows → `set` is empty → every row's `isolated` stays `false`. Same as flag-off equivalent.

### Rollback

- **Fastest disable**: `cf set-env tutorials-srv KG_WCC_ISOLATION_THRESHOLD 0 && cf restart tutorials-srv`. The next nightly run TRUNCATEs + inserts zero rows; badge disappears from every LR within 24h. To empty immediately, manually invoke `runKgWcc()` via `cf run-task tutorials-srv "node -e 'import(...)'"` or the JobControls admin action.
- **Job stop**: comment out `registerJob('kg-wcc')` in `srv/jobs/scheduler.js` and redeploy. Sidecar snapshot persists harmlessly.
- **Full removal**: drop the `KgIsolation` entity, `srv/jobs/kg-wcc-job.js`, both `on(READ)` decorators, and the four annotation additions. `virtual null as isolated` elements can stay (nullable, no reader would depend on them without the decorator) or be dropped via a CDS migration.

**No data corruption path.** `KgIsolation` is a materialized derived table; the source is `KG_PG_VERTICES_V` + `KG_PG_EDGES_V`, both live views. Worst case is stale flags (multi-day-old isolation), which still fail-quiet to "no badge" once the threshold is set to 0 or the table is manually emptied.

## Rollout

1. **Merge dark.** Merge #918 with default threshold (`1`), no env override. Job runs nightly starting the next 04:07 UTC.
2. **Verify data.** Morning after first run:
   - `SELECT COUNT(*) FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION"` — expect a small number (tens, not thousands, on a healthy DEV graph).
   - `SELECT VERTEXTYPE, COUNT(*) FROM KgIsolation GROUP BY VERTEXTYPE` — sanity-check the concept/tutorial split.
   - Spot-check a flagged slug in the Concepts LR: badge visible, filter-by-isolated returns it.
3. **DEV soak.** 48h of curator activity. Monitor `kg_wcc_failures` (must be 0), `kg_wcc_duration_ms` p95 (should be sub-second), and eyeball whether the flagged rows are, in fact, curation gaps.
4. **Tune threshold if needed.** If curators say "we want size-2 too" — `cf set-env tutorials-srv KG_WCC_ISOLATION_THRESHOLD 2 && cf restart tutorials-srv`. Next nightly run refills.
5. **PROD.** Out of scope for #918. DEV-only per the parent spike #913 non-goals.

### Success criteria

- Nightly job wall-clock < 60s at prod scale.
- Zero `kg_wcc_failures` in 48h DEV soak.
- Curators find ≥ 3 real curation gaps in the first week of the badge being live.

## Non-goals (from issue #918)

1. Not surfacing isolation to visitors.
2. Not auto-fixing (no "suggest a concept to link to" — badge exists only to prompt manual curator action).

## Related work

- **#913** — property-graph spike (parent). Established `KG_PG_WORKSPACE` + views.
- **#919** — widened workspace to 9 predicates (unblocking prereq, merged).
- **#916** — PageRank in Node.js (sibling algorithm). Templates the sidecar / scheduler / hybrid-test shape reused here.
- **#917** — Louvain community detection (sibling, spec landed). Templates the vertex-type discriminator shape.
