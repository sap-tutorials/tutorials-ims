# KG Weakly-Connected-Component Isolation Flag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md`](../specs/2026-07-04-918-kg-wcc-isolation-design.md)

**Goal:** Nightly Node.js union-find over `KG_PG_WORKSPACE` populates a `KgIsolation` sidecar; admin Concepts and Tutorials List Reports render an "Isolated" badge on rows in a component of size ≤ `KG_WCC_ISOLATION_THRESHOLD` (default 1).

**Architecture:** New pure-function `computeWcc(vertices, edges)` in `srv/jobs/kg-wcc-job.js` with a DB-integrated wrapper `runKgWcc()` registered at 04:07 UTC in `srv/jobs/scheduler.js`. New sidecar entity `KgIsolation` in `db/knowledge-graph-isolation.cds`. Two service projections gain a virtual `isolated : Boolean` element populated by `after('READ')` decorators that batch-query `KgIsolation` per page. Two annotation blocks in `app/admin-annotations.cds` add the `isolated` LineItem column with red criticality when true.

**Tech Stack:** SAP CAP Node.js (`@sap/cds`), Fiori Elements V4 annotations, SAP HANA Cloud (HDI), Vitest.

## Global Constraints

- **Compute path**: Node.js only. No `.hdbprocedure` artifact. HANA GraphScript has no WCC primitive (confirmed by #916 Task 0 builtins enumeration).
- **Vertex scope for the flag**: `concept` and `tutorial` only. The WCC pass sees all seven vertex types in `KG_PG_VERTICES_V` but only these two are materialized into `KgIsolation`.
- **Storage shape**: single sidecar `KgIsolation` keyed by `(vertexType, slug)`. Never `managed`. `@cds.autoexpose: false`. Not on any top-level OData collection.
- **Threshold**: env var `KG_WCC_ISOLATION_THRESHOLD`, parsed via `parseInt(..., 10) || 1`, default `1`. Value `0` empties the table.
- **Raw parameterized `INSERT`** (not `INSERT.into(...).entries`) in the job body — matches the invocation-path-independence contract that #916 landed in commit `6a715d0f`.
- **Naming**: HANA table name `COM_SAP_DEVELOPERS_IMS_KGISOLATION`. Job name `kg-wcc`. Schedule `7 4 * * *` (04:07 UTC daily).
- **Fail-quiet contract**: no error path in the `after('READ')` decorator ever propagates to the client. `KgIsolation` missing/throwing → `isolated` stays unset (Fiori renders no badge). Job failure → `kg_wcc_failures` counter increments; yesterday's sidecar snapshot stays live.
- **Test guards**: hybrid test uses lowercase prefix `__test__kg-wcc-<runId>-`. Gated by `ALLOW_HYBRID_WRITES=true` via `test/hybrid/_guard.js::isSafeForWrites()`.
- **CI Node 22 vs local Node 24** — hybrid test must use `cds.entities(NS)` references, not bare projection names (per [ci-node-version-mismatch.md](../../../C:/Users/I809764/.claude/projects/D--projects-tutorials-poc/memory/ci-node-version-mismatch.md)).
- **CRLF hygiene** (Windows): all new files LF-only. If any edit tool inserts CRLF, normalize before commit.

---

### Task 1: Pure `computeWcc` core + unit tests

**Files:**
- Create: `srv/jobs/kg-wcc-job.js` (Node.js job — pure core only in this task; DB-integrated `runKgWcc` in Task 3)
- Test: `test/unit/kg-wcc-compute.test.js`

**Interfaces:**
- Produces:
  - `export function computeWcc(vertices: string[], edges: Array<[string, string]>): { components: Array<{vertexKey: string, componentId: string, componentSize: number}>, componentCount: number }`

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/kg-wcc-compute.test.js`:

```js
// test/unit/kg-wcc-compute.test.js
//
// Unit tests for the pure-function WCC core (computeWcc).
// Synthetic in-memory graphs — no DB, no CDS model. Any algorithm
// regression surfaces on every `npm test` before hybrid or smoke.
//
// The DB-integrated path (runKgWcc against real KG_PG_EDGES_V) is
// covered by the hybrid test at test/hybrid/kg-wcc.test.js.
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918

import { describe, it, expect } from 'vitest';
import { computeWcc } from '../../srv/jobs/kg-wcc-job.js';

describe('computeWcc — pure function core', () => {
  it('returns empty result for an empty vertex set', () => {
    const { components, componentCount } = computeWcc([], []);
    expect(components).toEqual([]);
    expect(componentCount).toBe(0);
  });

  it('flags every isolated vertex as its own component', () => {
    const { components, componentCount } = computeWcc(['a', 'b', 'c'], []);
    expect(componentCount).toBe(3);
    for (const c of components) {
      expect(c.componentSize).toBe(1);
      expect(c.componentId).toBe(c.vertexKey);
    }
  });

  it('unions two vertices joined by one edge', () => {
    const { components, componentCount } = computeWcc(
      ['a', 'b'],
      [['a', 'b']],
    );
    expect(componentCount).toBe(1);
    expect(components[0].componentSize).toBe(2);
    expect(components[1].componentSize).toBe(2);
    expect(components[0].componentId).toBe(components[1].componentId);
  });

  it('separates two disconnected clusters', () => {
    // a-b-c cluster, d-e cluster, f isolated.
    const { components, componentCount } = computeWcc(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      [['a', 'b'], ['b', 'c'], ['d', 'e']],
    );
    expect(componentCount).toBe(3);
    const byKey = new Map(components.map(c => [c.vertexKey, c]));
    expect(byKey.get('a').componentSize).toBe(3);
    expect(byKey.get('b').componentSize).toBe(3);
    expect(byKey.get('c').componentSize).toBe(3);
    expect(byKey.get('a').componentId).toBe(byKey.get('b').componentId);
    expect(byKey.get('a').componentId).toBe(byKey.get('c').componentId);
    expect(byKey.get('d').componentSize).toBe(2);
    expect(byKey.get('e').componentSize).toBe(2);
    expect(byKey.get('d').componentId).toBe(byKey.get('e').componentId);
    expect(byKey.get('f').componentSize).toBe(1);
    expect(byKey.get('a').componentId).not.toBe(byKey.get('d').componentId);
    expect(byKey.get('a').componentId).not.toBe(byKey.get('f').componentId);
  });

  it('treats directed edges as undirected (a→b and c→b unify all three)', () => {
    // Guards against a future refactor accidentally adding direction-awareness.
    const { componentCount } = computeWcc(
      ['a', 'b', 'c'],
      [['a', 'b'], ['c', 'b']],
    );
    expect(componentCount).toBe(1);
  });

  it('skips self-loops without merging anything', () => {
    // a-a is a self-loop; a stays a singleton component.
    const { components, componentCount } = computeWcc(
      ['a', 'b'],
      [['a', 'a']],
    );
    expect(componentCount).toBe(2);
    const byKey = new Map(components.map(c => [c.vertexKey, c]));
    expect(byKey.get('a').componentSize).toBe(1);
    expect(byKey.get('b').componentSize).toBe(1);
  });

  it('skips orphan edges (source or target not in vertex set)', () => {
    // Edge [a, 'nonexistent'] should be dropped, not throw.
    const { components, componentCount } = computeWcc(
      ['a', 'b'],
      [['a', 'nonexistent'], ['b', 'also-missing']],
    );
    expect(componentCount).toBe(2);
    const byKey = new Map(components.map(c => [c.vertexKey, c]));
    expect(byKey.get('a').componentSize).toBe(1);
    expect(byKey.get('b').componentSize).toBe(1);
  });

  it('handles a long chain (100 vertices) as one component', () => {
    // Regression guard for union-by-rank / path-compression correctness at
    // depth. Without both, this pathological chain would still be a single
    // component but find() would be O(N) per call.
    const N = 100;
    const vertices = Array.from({ length: N }, (_, i) => `v${i}`);
    const edges = Array.from({ length: N - 1 }, (_, i) => [`v${i}`, `v${i+1}`]);
    const { components, componentCount } = computeWcc(vertices, edges);
    expect(componentCount).toBe(1);
    const rootIds = new Set(components.map(c => c.componentId));
    expect(rootIds.size).toBe(1);
    for (const c of components) expect(c.componentSize).toBe(N);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run test/unit/kg-wcc-compute.test.js
```

Expected: FAIL with module-resolution error (`srv/jobs/kg-wcc-job.js` does not exist yet).

- [ ] **Step 3: Write the pure core in `srv/jobs/kg-wcc-job.js`**

Create `srv/jobs/kg-wcc-job.js` (only the pure `computeWcc` export in this task; the DB-integrated `runKgWcc` follows in Task 3 to keep this task's diff test-only):

```js
// srv/jobs/kg-wcc-job.js
// ============================================================
// Nightly weakly-connected-components pass over KG_PG_WORKSPACE,
// materialized into the KgIsolation sidecar.
//
// COMPUTE PATH (locked with Tom 2026-07-04)
// HANA GraphScript has no WCC primitive — the #916 Task 0 probe
// enumerated the full BUILTIN_FUNCTIONS_ALGORITHMS set and confirmed
// only Strongly_Connected_Components exists on the connectivity side.
// So this job runs union-find in Node.js against KG_PG_VERTICES_V
// + KG_PG_EDGES_V. Wall-clock at 17k vertices / 40k edges is
// sub-second (union-find is O(N + M · α(N))).
//
// GRAPH ORIENTATION
// Every incoming edge unions both endpoints regardless of direction.
// The workspace has directed edges (concept→concept `requires`,
// tutorial→concept `teaches`) but every request-time consumer
// (KG_SHORTEST_PATH_GRAPH's direction 'ANY', PageRank's undirected
// projection) treats the KG as an undirected navigation surface;
// WCC does the same.
//
// FAIL-QUIET SEMANTICS
// This job's failure never breaks request-time reads: the ranker
// decorator in knowledge-graph-service.js / admin-service.js catches
// any SELECT throw and leaves `isolated` unset. If this job errors,
// the DB keeps yesterday's rows (or empty tables) and the admin LR
// simply shows no badges.
//
// TRANSACTION SHAPE
// TRUNCATE + batched INSERTs are wrapped in one db.tx. If the batch
// loop throws (e.g. HANA deadlock, network blip), the whole thing
// rolls back and yesterday's rows stay visible. No partial write is
// ever observable to a reader.
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918
// ============================================================

// Batch insert size — same as kg-pagerank-job.js. A KgIsolation row
// is a vertexType (≤16B) + slug (≤255B) + componentId (≤280B) + int
// + timestamp; each batch is well under HANA's 32MB statement cap.
const INSERT_BATCH_SIZE = 500;

// ============================================================
// Pure-function core — union-find over an edge list.
//
// Exposed as an export so the unit tests can drive it with synthetic
// vertex/edge lists without a DB. The DB-integrated path in
// runKgWcc drives the same function against KG_PG_VERTICES_V +
// KG_PG_EDGES_V — no algorithmic divergence.
// ============================================================

/**
 * Compute weakly-connected components over an edge list. Edges are
 * treated as undirected regardless of the (source, target) tuple
 * order — union-find is inherently undirected.
 *
 * Self-loops and edges referencing a vertex not present in the
 * vertex set are silently skipped (a dangling edge would either
 * crash the index lookup or double-count a self-loop; both are
 * bugs, not signal).
 *
 * @param {string[]} vertices — vertex keys (from KG_PG_VERTICES_V.VERTEX_KEY).
 * @param {Array<[string,string]>} edges — [source, target] pairs
 *   (from KG_PG_EDGES_V).
 * @returns {{components: Array<{vertexKey: string, componentId: string, componentSize: number}>, componentCount: number}}
 *   `components[i]` is the WCC assignment for `vertices[i]`.
 *   `componentId` is the vertex-key of the union-find root that
 *   emerged from the merge order — opaque and NOT stable across runs.
 *   `componentSize` is the count of vertices in that component.
 */
export function computeWcc(vertices, edges) {
  const N = vertices.length;
  if (N === 0) {
    return { components: [], componentCount: 0 };
  }

  // Map vertex-key → dense index. The union-find arrays are indexed
  // by this position so find/union are tight numeric ops on
  // typed arrays.
  const indexOf = new Map();
  for (let i = 0; i < N; i++) indexOf.set(vertices[i], i);

  const parent = new Int32Array(N);
  const rank = new Int8Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;

  // Path-compression find. Iterative to avoid blowing the stack on
  // pathological chains.
  function find(x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }

  // Union by rank — keeps the tree shallow enough that find() is
  // near-constant amortized.
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra]++;
    }
  }

  for (const [src, dst] of edges) {
    const i = indexOf.get(src);
    const j = indexOf.get(dst);
    if (i === undefined || j === undefined) continue;  // orphan edge
    if (i === j) continue;                              // self-loop
    union(i, j);
  }

  // Second pass — compact-find every vertex to its root, count
  // vertices per root, materialize the per-vertex result.
  const rootOf = new Int32Array(N);
  const sizeByRoot = new Map();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    rootOf[i] = r;
    sizeByRoot.set(r, (sizeByRoot.get(r) || 0) + 1);
  }

  const components = new Array(N);
  for (let i = 0; i < N; i++) {
    const r = rootOf[i];
    components[i] = {
      vertexKey: vertices[i],
      componentId: vertices[r],
      componentSize: sizeByRoot.get(r),
    };
  }
  return { components, componentCount: sizeByRoot.size };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run test/unit/kg-wcc-compute.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/kg-wcc-job.js test/unit/kg-wcc-compute.test.js
git commit -m "feat(#918): pure computeWcc core with union-find + unit tests"
```

---

### Task 2: `KgIsolation` sidecar entity

**Files:**
- Create: `db/knowledge-graph-isolation.cds`

**Interfaces:**
- Produces:
  - CDS entity `com.sap.developers.ims.KgIsolation` with composite key `(vertexType, slug)` + `componentId : String(280)` + `componentSize : Integer` + `computedAt : Timestamp`.
  - HANA table name `COM_SAP_DEVELOPERS_IMS_KGISOLATION`.

No test in this task — the entity is exercised by Task 6's hybrid test. HDI compile is the gate.

- [ ] **Step 1: Write the entity file**

Create `db/knowledge-graph-isolation.cds`:

```cds
// db/knowledge-graph-isolation.cds
//
// KgIsolation — sidecar flag for concepts/tutorials in small
// weakly-connected components.
//
// Populated nightly by srv/jobs/kg-wcc-job.js at 04:07 UTC. One row
// per flagged vertex; (vertexType, slug) is the composite PK.
// componentId is the union-find root vertex-key (opaque; not stable
// across runs — the union-find picks whatever root emerges from the
// merge order). componentSize is the count of vertices in that
// component. Rows only exist when componentSize is <=
// KG_WCC_ISOLATION_THRESHOLD (default 1).
//
// NOT `managed` — nightly TRUNCATE+INSERT overwrite semantics; the
// `managed` timestamps/user columns would be trigger noise on a
// rebuilt-from-scratch aggregate. `computedAt` captures the batch
// time.
//
// @cds.autoexpose: false — never a top-level OData collection;
// reached only through the `isolated` virtual on Concepts / Tutorials
// projections (see srv/knowledge-graph-service.cds and
// srv/admin-service.cds).
//
// Slug widths chosen so a single String(255) column covers both
// vertex-types:
//   Concepts.slug  = String(80)
//   Tutorials.slug = String(255)
// componentId is a KG_PG_VERTICES_V.VERTEX_KEY (NVARCHAR(280)) —
// see db/src/views/KG_PG_VERTICES_V.hdbview line 6-9 for the sizing
// derivation.
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918

namespace com.sap.developers.ims;

@cds.autoexpose: false
entity KgIsolation {
  key vertexType    : String(16);   // 'concept' | 'tutorial'
  key slug          : String(255);
      componentId   : String(280);
      componentSize : Integer;
      computedAt    : Timestamp;
}
```

- [ ] **Step 2: Verify CDS compile succeeds**

Run:
```bash
npx cds compile db/ --to sql 2>&1 | grep -iE "(error|KgIsolation)" | head -20
```

Expected: no `error:` lines. At least one line mentions `KGISOLATION` (the compiled table name).

- [ ] **Step 3: Verify the HANA table name compiles as expected**

Run:
```bash
npx cds compile db/ --to hana 2>&1 | grep -iE "COM_SAP_DEVELOPERS_IMS_KGISOLATION" | head -5
```

Expected: at least one line mentioning `COM_SAP_DEVELOPERS_IMS_KGISOLATION` (`CREATE COLUMN TABLE` in the compiled output).

- [ ] **Step 4: Rebuild `db/last-dev/` — schema change requires `cds build --production`**

Per the [global-tooling gotcha](../../../C:/Users/I809764/.claude/projects/D--projects-tutorials-poc/memory/MEMORY.md) — `cds build --production` (not `cds compile`) after any schema change that must land in `db/last-dev/`:

```bash
npx cds build --production
```

Expected: exits 0. `db/last-dev/csn.json` updates.

- [ ] **Step 5: Commit**

```bash
git add db/knowledge-graph-isolation.cds db/last-dev/
git commit -m "feat(#918): KgIsolation sidecar entity for WCC isolation flag"
```

---

### Task 3: DB-integrated `runKgWcc` + scheduler registration

**Files:**
- Modify: `srv/jobs/kg-wcc-job.js` (append `runKgWcc` export + imports + LOG + constants)
- Modify: `srv/jobs/scheduler.js` (import + `registerJob` block)

**Interfaces:**
- Consumes:
  - `computeWcc` from Task 1
  - `KgIsolation` entity from Task 2 (via raw HANA table name `COM_SAP_DEVELOPERS_IMS_KGISOLATION`)
- Produces:
  - `export async function runKgWcc(): Promise<{ componentCount: number, isolatedCount: number, readMs: number, computeMs: number, writeMs: number, durationMs: number }>`

- [ ] **Step 1: Append imports, LOG, constants, and `runKgWcc` to `srv/jobs/kg-wcc-job.js`**

Prepend three imports at the top of `srv/jobs/kg-wcc-job.js` (just after the file header, above `const INSERT_BATCH_SIZE`):

```js
import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const LOG = cds.log('kg-wcc');

// HANA table name for the sidecar (bytecode name emitted by CAP for
// the KgIsolation CDS entity in db/knowledge-graph-isolation.cds).
// Raw table name — parameterized INSERT below — because this job may
// be invoked via `cf run-task ... node -e` which skips the CAP
// cds.server bootstrap, and `cds.entities()` is undefined in that
// context. Matches the invocation-path-independence fix that #916
// landed in commit 6a715d0f.
const KG_ISOLATION_TABLE = '"COM_SAP_DEVELOPERS_IMS_KGISOLATION"';
```

Append this block to the end of `srv/jobs/kg-wcc-job.js`:

```js
// ============================================================
// DB-integrated entry point — the scheduler calls this.
//
// Reads the workspace, runs computeWcc, then filters the per-vertex
// result to (vertexType IN ('concept','tutorial') AND componentSize
// <= threshold) before writing to KgIsolation. All non-flagged
// vertices are silently dropped — the sidecar only exists to
// materialize the "flag me" signal.
// ============================================================

/**
 * Read KG_WCC_ISOLATION_THRESHOLD; parseInt, fall back to 1 on
 * NaN or negative. 0 is honored (empties the table).
 */
function readThreshold() {
  const raw = process.env.KG_WCC_ISOLATION_THRESHOLD;
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 1;
  return n;
}

export async function runKgWcc() {
  const threshold = readThreshold();
  const t0 = Date.now();
  const db = await cds.connect.to('db');

  try {
    // 1. Load vertices + edges from the workspace views. Same rows
    //    the PageRank job at srv/jobs/kg-pagerank-job.js reads.
    const vertexRows = await db.run(
      'SELECT VERTEX_KEY, VERTEX_TYPE, SLUG FROM KG_PG_VERTICES_V',
    );
    const edgeRows = await db.run(
      'SELECT "SOURCE", "TARGET" FROM KG_PG_EDGES_V',
    );
    const readMs = Date.now() - t0;

    // 2. Run union-find. Undirected.
    const vertexKeys = vertexRows.map(r => r.VERTEX_KEY);
    const edges = edgeRows.map(r => [r.SOURCE, r.TARGET]);
    const t1 = Date.now();
    const { components, componentCount } = computeWcc(vertexKeys, edges);
    const computeMs = Date.now() - t1;

    // 3. Zip compute results back to (vertexType, slug) and filter
    //    to the two vertex types we materialize, plus the size
    //    threshold. Non-flagged vertices are dropped — the sidecar
    //    only tracks the signal, not the full graph.
    const now = new Date().toISOString();
    const toInsert = [];
    for (let i = 0; i < vertexRows.length; i++) {
      const v = vertexRows[i];
      const c = components[i];
      if (!v.SLUG) continue;
      if (v.VERTEX_TYPE !== 'concept' && v.VERTEX_TYPE !== 'tutorial') continue;
      if (c.componentSize > threshold) continue;
      toInsert.push({
        vertexType: v.VERTEX_TYPE,
        slug: v.SLUG,
        componentId: c.componentId,
        componentSize: c.componentSize,
        computedAt: now,
      });
    }

    // 4. Atomic swap in one tx: TRUNCATE + batched INSERTs. If the
    //    batch loop throws mid-way, HANA rolls back to yesterday's
    //    rows — readers never see a partial state.
    const t2 = Date.now();
    const INSERT_SQL =
      `INSERT INTO ${KG_ISOLATION_TABLE} ` +
      `(VERTEXTYPE, SLUG, COMPONENTID, COMPONENTSIZE, COMPUTEDAT) ` +
      `VALUES (?, ?, ?, ?, ?)`;
    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${KG_ISOLATION_TABLE}`);
      for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
        const batch = toInsert.slice(i, i + INSERT_BATCH_SIZE);
        await tx.run(
          INSERT_SQL,
          batch.map((r) => [
            r.vertexType, r.slug, r.componentId, r.componentSize, r.computedAt,
          ]),
        );
      }
    });
    const writeMs = Date.now() - t2;

    const durationMs = Date.now() - t0;
    metrics.observe('kg_wcc_duration_ms', durationMs);
    metrics.gauge('kg_wcc_component_count', componentCount);
    metrics.gauge('kg_wcc_isolated_count', toInsert.length);

    LOG.info(
      `WCC: ${vertexKeys.length} vertices / ${edges.length} edges → ` +
      `${componentCount} components, ${toInsert.length} isolated ` +
      `(threshold=${threshold}, read=${readMs}ms, compute=${computeMs}ms, ` +
      `write=${writeMs}ms, total=${durationMs}ms)`,
    );

    return {
      componentCount,
      isolatedCount: toInsert.length,
      readMs,
      computeMs,
      writeMs,
      durationMs,
    };
  } catch (err) {
    metrics.counter('kg_wcc_failures');
    LOG.error('WCC job failed', err);
    throw err;
  }
}
```

- [ ] **Step 2: Register the job in `srv/jobs/scheduler.js`**

Add the import near the other job imports at the top of `srv/jobs/scheduler.js` (around line 49-50, alongside `import { runKgPageRank } from './kg-pagerank-job.js';`):

```js
import { runKgWcc } from './kg-wcc-job.js';
```

Add a `registerJob` block inside `registerJobs()` — insert it right after the `kg-pagerank` block that ends around line 602 (schedule `'53 3 * * *'`), keeping the KG algorithms clustered:

```js
  // Daily 04:07 UTC — weakly-connected-components pass over the KG
  // property graph. Populates KgIsolation with rows for concept and
  // tutorial vertices whose WCC size <= KG_WCC_ISOLATION_THRESHOLD
  // (default 1). Runs after PageRank (03:53) and the planned Louvain
  // slot (03:57) so all three algorithms see the same nightly
  // snapshot of KG_PG_WORKSPACE. Off-minute (:07) — 04:00 / 04:11 /
  // 04:17 / 04:23 / 04:33 / 04:43 / 04:31 M+Th are already taken.
  // ttlMs 10 min — expected wall-clock at 17k vertices / 40k edges
  // is sub-second (union-find is O(N + M · α(N))); 10-min ceiling
  // is loud headroom. Fail-quiet: job errors never break request-time
  // reads (the on(READ) decorators catch SELECT throws and leave
  // `isolated` unset). Spec:
  // docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
  // Issue: #918
  registerJob({
    jobName: 'kg-wcc',
    schedule: '7 4 * * *',
    ttlMs: 600000,
    description: 'Weakly-connected components over KG_PG_WORKSPACE — populates KgIsolation sidecar (#918)',
    fn: () => runKgWcc(),
  });
```

- [ ] **Step 3: Confirm boot doesn't regress**

Run:
```bash
node -e "import('./srv/jobs/kg-wcc-job.js').then(m => console.log('exports:', Object.keys(m)));"
```

Expected: `exports: [ 'computeWcc', 'runKgWcc' ]`.

Then confirm the scheduler file still parses:
```bash
node --check srv/jobs/scheduler.js && echo "scheduler.js OK"
```

Expected: `scheduler.js OK`.

- [ ] **Step 4: Re-run the unit tests to make sure Task 1's still pass with the new imports at the top**

Run:
```bash
npx vitest run test/unit/kg-wcc-compute.test.js
```

Expected: PASS, 8 tests. (The pure `computeWcc` doesn't touch cds or metrics, so the module-level `import cds` shouldn't affect it — but this catches a regression from a bad edit.)

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/kg-wcc-job.js srv/jobs/scheduler.js
git commit -m "feat(#918): DB-integrated runKgWcc + nightly scheduler registration"
```

---

### Task 4: Virtual `isolated` element + `after('READ')` decorators

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (add `virtual` element to the `Concepts` projection)
- Modify: `srv/knowledge-graph-service.js` (add `after('READ', 'Concepts')` handler)
- Modify: `srv/admin-service.cds` (add `virtual` element to the `Tutorials` projection)
- Modify: `srv/admin-service.js` (add `after('READ', 'Tutorials')` handler)

**Interfaces:**
- Consumes: `KgIsolation` HANA table from Task 2, populated by Task 3's job (or empty on first-run — fail-quiet path).
- Produces: `isolated : Boolean` field on `KnowledgeGraphService.Concepts` and `AdminService.Tutorials` OData reads. `true` iff a `KgIsolation` row exists for `(vertexType, slug)`; `false`/`null` otherwise.

- [ ] **Step 1: Add virtual to `srv/knowledge-graph-service.cds`**

Locate the `Concepts` projection at `srv/knowledge-graph-service.cds:58`:

```cds
  entity Concepts                       as projection on ims.Concepts excluding { embedding };
```

Replace with:

```cds
  entity Concepts                       as projection on ims.Concepts excluding { embedding } {
    *,
    // #918 — populated by after('READ') decorator in knowledge-graph-service.js.
    // True iff a KgIsolation row exists for this concept slug. Fail-quiet:
    // if the SELECT throws or the sidecar is missing, stays null (Fiori
    // renders no badge — same visual result as false).
    virtual null as isolated : Boolean,
  };
```

- [ ] **Step 2: Add virtual to `srv/admin-service.cds`**

Locate the `Tutorials` projection at `srv/admin-service.cds:28-56`. It's already a projection block with column-list body. Insert the virtual as the **last** field, just after the `author.lastName` flattened field (line 56):

```cds
    author.lastName    as authorLastName : String @Common.FieldControl: #ReadOnly,
    // #918 — populated by after('READ') decorator in admin-service.js.
    // True iff a KgIsolation row exists for this tutorial slug. Fail-quiet:
    // if the SELECT throws or the sidecar is missing, stays null.
    virtual null as isolated : Boolean
  };
```

Note the removed trailing comma on `authorLastName` — CDS accepts either but keep the style consistent with the existing projection.

- [ ] **Step 3: Add `after('READ', 'Concepts')` decorator to `srv/knowledge-graph-service.js`**

Find the `cds.service.impl` callback in `srv/knowledge-graph-service.js` (look for `module.exports = cds.service.impl(async function` near the top). Inside that callback, add this handler alongside the existing ones (position doesn't matter, but keeping it near other READ handlers is cleanest):

```js
  // #918 — populate the virtual `isolated` flag from the KgIsolation
  // sidecar. Batched per page (one IN-clause query for the page's slugs);
  // Fiori Elements requests 30 rows/page by default, so this is one
  // small query per LR page load. Fail-quiet: any error leaves `isolated`
  // unset (Fiori renders no badge). Spec:
  // docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
  this.after('READ', 'Concepts', async (rows, req) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const slugs = rows.map(r => r.slug).filter(Boolean);
    if (slugs.length === 0) return;
    try {
      const placeholders = slugs.map(() => '?').join(',');
      const flagged = await cds.tx(req).run(
        `SELECT SLUG FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
        `WHERE VERTEXTYPE = ? AND SLUG IN (${placeholders})`,
        ['concept', ...slugs],
      );
      const set = new Set(flagged.map(r => r.SLUG));
      for (const r of rows) {
        if (r.slug) r.isolated = set.has(r.slug);
      }
    } catch (err) {
      cds.log('kg-wcc').warn(
        'isolated flag lookup failed on Concepts; leaving field unset',
        err && err.message ? err.message : err,
      );
    }
  });
```

- [ ] **Step 4: Add `after('READ', 'Tutorials')` decorator to `srv/admin-service.js`**

Find the `cds.service.impl` callback (or equivalent module-level handler wiring) in `srv/admin-service.js`. Add:

```js
  // #918 — populate the virtual `isolated` flag from the KgIsolation
  // sidecar for tutorial rows. Same shape as the Concepts decorator in
  // srv/knowledge-graph-service.js.
  this.after('READ', 'Tutorials', async (rows, req) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const slugs = rows.map(r => r.slug).filter(Boolean);
    if (slugs.length === 0) return;
    try {
      const placeholders = slugs.map(() => '?').join(',');
      const flagged = await cds.tx(req).run(
        `SELECT SLUG FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
        `WHERE VERTEXTYPE = ? AND SLUG IN (${placeholders})`,
        ['tutorial', ...slugs],
      );
      const set = new Set(flagged.map(r => r.SLUG));
      for (const r of rows) {
        if (r.slug) r.isolated = set.has(r.slug);
      }
    } catch (err) {
      cds.log('kg-wcc').warn(
        'isolated flag lookup failed on Tutorials; leaving field unset',
        err && err.message ? err.message : err,
      );
    }
  });
```

Note: if `srv/admin-service.js` uses a class-based `cds.ApplicationService` (some services in this repo do), the handler goes inside the class body's `async init()` method after `await super.init()`. Read the file first and match its shape.

- [ ] **Step 5: Rebuild `db/last-dev/` (schema-adjacent projection change)**

Run:
```bash
npx cds build --production
```

Expected: exits 0.

- [ ] **Step 6: Sanity-check the services still boot**

Run:
```bash
node -e "import('@sap/cds').then(cds => cds.default.load(['srv/knowledge-graph-service.cds','srv/admin-service.cds']).then(csn => console.log('KGS.Concepts.elements.isolated =', csn.definitions['KnowledgeGraphService.Concepts'].elements.isolated?.type)))"
```

Expected: `KGS.Concepts.elements.isolated = cds.Boolean`.

- [ ] **Step 7: Commit**

```bash
git add srv/knowledge-graph-service.cds srv/knowledge-graph-service.js srv/admin-service.cds srv/admin-service.js db/last-dev/
git commit -m "feat(#918): virtual 'isolated' element + on(READ) decorators for Concepts and Tutorials"
```

---

### Task 5: Fiori LineItem badge + label + SelectionFields

**Files:**
- Modify: `app/admin-annotations.cds` (add label + LineItem cell + SelectionFields entry for `isolated`, in both the `KnowledgeGraphService.Concepts` and `AdminService.Tutorials` annotation blocks)

**Interfaces:**
- Consumes: `isolated : Boolean` field from Task 4's projections.
- Produces: red criticality badge cell in both admin LRs.

- [ ] **Step 1: Add label annotation to `KnowledgeGraphService.Concepts`**

Locate `app/admin-annotations.cds:2499`:

```cds
annotate KnowledgeGraphService.Concepts with {
  slug            @Common.Label: 'Slug'           @Common.FieldControl: #ReadOnly;
  ...
  publishedBy     @Common.Label: 'Published By'   @Common.FieldControl: #ReadOnly;
};
```

Add one line before the closing `};`:

```cds
  publishedBy     @Common.Label: 'Published By'   @Common.FieldControl: #ReadOnly;
  isolated        @Common.Label: 'Isolated'       @Common.FieldControl: #ReadOnly;
};
```

- [ ] **Step 2: Add SelectionFields entry + LineItem cell to `KnowledgeGraphService.Concepts` `@UI` block**

Locate the `annotate KnowledgeGraphService.Concepts with @( ... )` block near `app/admin-annotations.cds:2513`. Two edits inside that block:

**(a) `UI.SelectionFields`** — currently `[ status, slug ]`. Extend to:

```cds
  UI.SelectionFields: [ status, slug, isolated ],
```

**(b) `UI.LineItem`** — after the existing `publishedAt` cell (the one at `app/admin-annotations.cds:2537` with the `$edmJson`/`$If` criticality), append:

```cds
    {
      $Type: 'UI.DataField',
      Value: isolated,
      Label: 'Isolated',
      // #918 — Criticality 1 (Negative/red) when true, 0 (Neutral) when
      // false or null. OData V4 CriticalityType: 0=Neutral, 1=Negative,
      // 2=Critical, 3=Positive. Mirrors the `publishedAt` $edmJson
      // pattern above.
      Criticality: { $edmJson: { $If: [ { $Path: 'isolated' }, 1, 0 ] } }
    },
```

Position: right after the `publishedAt` DataField so the "Isolated" column sits adjacent to the other curation-status columns. Before `extractionCount`.

- [ ] **Step 3: Annotate `AdminService.Tutorials`**

Locate the `annotate AdminService.Tutorials with { ... }` block at `app/admin-annotations.cds:520` (labels). Add:

```cds
  isolated @Common.Label: 'Isolated' @Common.FieldControl: #ReadOnly;
```

Locate `annotate AdminService.Tutorials with @UI` at `app/admin-annotations.cds:574` (the block with `LineItem` and `SelectionFields`). Two edits:

**(a)** Extend `UI.SelectionFields` to include `isolated`. Read the file section to see the current array and append `, isolated` to the last element.

**(b)** Append this `DataField` to `UI.LineItem` (put it near the end, before any `ID` copy-cell if one exists — mirroring the Concepts positioning):

```cds
    {
      $Type: 'UI.DataField',
      Value: isolated,
      Label: 'Isolated',
      Criticality: { $edmJson: { $If: [ { $Path: 'isolated' }, 1, 0 ] } }
    },
```

- [ ] **Step 4: Compile CDS to catch annotation errors**

Run:
```bash
npx cds compile srv/ app/admin-annotations.cds --to json 2>&1 | grep -iE "(error|warn.*isolat)" | head -20
```

Expected: no `error:` lines. Warnings mentioning `isolated` (if any) should be inspected but non-blocking unless they say "not found."

- [ ] **Step 5: Rebuild `db/last-dev/` and CAP artifacts**

```bash
npx cds build --production
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds db/last-dev/
git commit -m "feat(#918): 'Isolated' badge column + selection filter in Concepts and Tutorials LRs"
```

---

### Task 6: Hybrid test

**Files:**
- Create: `test/hybrid/kg-wcc.test.js`

**Interfaces:**
- Consumes: `runKgWcc` from Task 3, `KgIsolation` entity from Task 2, projections from Task 4.

- [ ] **Step 1: Write the failing hybrid test**

Create `test/hybrid/kg-wcc.test.js`:

```js
// test/hybrid/kg-wcc.test.js
//
// End-to-end hybrid test — seeds an isolated/hub fixture in the LIVE
// DEV HDI, drives runKgWcc(), and verifies:
//   1. Isolated concept + isolated tutorial land in KgIsolation with
//      componentSize=1 at the default threshold (1).
//   2. Hub cluster (4 vertices linked via requires + teaches) does
//      NOT land in KgIsolation at threshold=1.
//   3. Bumping the threshold to 4 makes the hub cluster get flagged
//      too (componentSize=4 <= 4).
//   4. GET /admin/Tutorials and /graph/Concepts return `isolated:
//      true` for the flagged fixtures via the after('READ') decorators.
//
// SAFETY
//   All fixtures use TEST_PREFIX `__test__kg-wcc-`. afterAll cleans up
//   via LOWER(slug) LIKE. Gated by ALLOW_HYBRID_WRITES via _guard.js.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-wcc.test.js
//
// Spec:  docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
// Issue: #918

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { runKgWcc } from '../../srv/jobs/kg-wcc-job.js';

const TEST_PREFIX = `__test__kg-wcc-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const ISO_C  = `${TEST_PREFIX}${RUN_ID}-iso-c`;
const HUB_A  = `${TEST_PREFIX}${RUN_ID}-hub-c-a`;
const HUB_B  = `${TEST_PREFIX}${RUN_ID}-hub-c-b`;

const ISO_T  = `${TEST_PREFIX}${RUN_ID}-iso-t`;
const HUB_TA = `${TEST_PREFIX}${RUN_ID}-hub-t-a`;
const HUB_TB = `${TEST_PREFIX}${RUN_ID}-hub-t-b`;

const NS = 'com.sap.developers.ims';
const KGS = 'KnowledgeGraphService';
const AS  = 'AdminService';

const skip = !isSafeForWrites() || process.env.ALLOW_HYBRID_WRITES !== 'true';

describe.skipIf(skip)('runKgWcc hybrid — seeds isolated/hub fixture + verifies sidecar + projection', () => {
  let db;
  const seededConceptIds  = [];
  const seededTutorialIds = [];
  const seededEdgeIds     = [];
  const seededLinkIds     = [];

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Concepts, Tutorials, ConceptEdges, TutorialConceptLinks } = cds.entities(NS);

    // 3 concepts: 1 isolated + 2 hub. Ordering: Concepts first for FK
    // integrity when the ConceptEdge insert follows.
    const isoConceptId = crypto.randomUUID();
    const hubAConceptId = crypto.randomUUID();
    const hubBConceptId = crypto.randomUUID();
    seededConceptIds.push(isoConceptId, hubAConceptId, hubBConceptId);
    await db.run(INSERT.into(Concepts).entries([
      { ID: isoConceptId,  slug: ISO_C, name: 'Isolated Concept',  status: 'ACTIVE' },
      { ID: hubAConceptId, slug: HUB_A, name: 'Hub Concept A',     status: 'ACTIVE' },
      { ID: hubBConceptId, slug: HUB_B, name: 'Hub Concept B',     status: 'ACTIVE' },
    ]));

    // 3 tutorials: 1 isolated + 2 hub. Tutorials.legacyId must be
    // unique + non-null per the schema; use the runId as a suffix to
    // keep it collision-free.
    const isoTutId  = crypto.randomUUID();
    const hubTAId   = crypto.randomUUID();
    const hubTBId   = crypto.randomUUID();
    seededTutorialIds.push(isoTutId, hubTAId, hubTBId);
    await db.run(INSERT.into(Tutorials).entries([
      { ID: isoTutId, slug: ISO_T,  title: 'Isolated Tutorial',  legacyId: `wcc-${RUN_ID}-iso` , status: 'ACTIVE' },
      { ID: hubTAId,  slug: HUB_TA, title: 'Hub Tutorial A',     legacyId: `wcc-${RUN_ID}-ha`  , status: 'ACTIVE' },
      { ID: hubTBId,  slug: HUB_TB, title: 'Hub Tutorial B',     legacyId: `wcc-${RUN_ID}-hb`  , status: 'ACTIVE' },
    ]));

    // Hub concept A --requires--> Hub concept B. Bidirectionally
    // this joins the two hub concepts into one component.
    const edgeId = crypto.randomUUID();
    seededEdgeIds.push(edgeId);
    await db.run(INSERT.into(ConceptEdges).entries([
      { ID: edgeId, source_ID: hubAConceptId, target_ID: hubBConceptId, predicate: 'requires', status: 'ACTIVE' },
    ]));

    // Hub-tutorial-A teaches hub-concept-A, hub-tutorial-B teaches
    // hub-concept-B. Combined with the requires edge, all four hub
    // vertices are one component.
    const linkAId = crypto.randomUUID();
    const linkBId = crypto.randomUUID();
    seededLinkIds.push(linkAId, linkBId);
    await db.run(INSERT.into(TutorialConceptLinks).entries([
      { ID: linkAId, tutorial_ID: hubTAId, concept_ID: hubAConceptId, predicate: 'teaches' },
      { ID: linkBId, tutorial_ID: hubTBId, concept_ID: hubBConceptId, predicate: 'teaches' },
    ]));

    // NOTE: the isolated concept + isolated tutorial have NO edges,
    // so they land in size-1 components.
  }, 120000);

  afterAll(async () => {
    if (!db) return;
    const { Concepts, Tutorials, ConceptEdges, TutorialConceptLinks } = cds.entities(NS);

    // FK-safe teardown order: links → edges → tutorials → concepts.
    if (seededLinkIds.length) await db.run(DELETE.from(TutorialConceptLinks).where({ ID: { in: seededLinkIds } }));
    if (seededEdgeIds.length) await db.run(DELETE.from(ConceptEdges).where({ ID: { in: seededEdgeIds } }));
    if (seededTutorialIds.length) await db.run(DELETE.from(Tutorials).where({ ID: { in: seededTutorialIds } }));
    if (seededConceptIds.length) await db.run(DELETE.from(Concepts).where({ ID: { in: seededConceptIds } }));

    // Also nuke any fixture rows the job wrote to KgIsolation. The
    // job's TRUNCATE-INSERT means the whole table gets replaced each
    // run, but if a subsequent run misses (e.g. tests bail early),
    // this guarantees no leftover fixture pollution.
    await db.run(
      `DELETE FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" WHERE LOWER(SLUG) LIKE ?`,
      [`${TEST_PREFIX}${RUN_ID}-%`.toLowerCase()],
    );
  }, 120000);

  it('flags size-1 components at threshold 1; hub cluster is not flagged', async () => {
    process.env.KG_WCC_ISOLATION_THRESHOLD = '1';
    const { componentCount, isolatedCount } = await runKgWcc();
    expect(componentCount).toBeGreaterThan(0);
    expect(isolatedCount).toBeGreaterThan(0);   // at least our two isolated fixtures

    const rows = await db.run(
      `SELECT VERTEXTYPE, SLUG, COMPONENTSIZE FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
      `WHERE LOWER(SLUG) LIKE ? ORDER BY VERTEXTYPE, SLUG`,
      [`${TEST_PREFIX}${RUN_ID}-%`.toLowerCase()],
    );
    // Expect exactly two: the isolated concept + the isolated tutorial.
    // Hub cluster's four vertices are all in one component of size 4, > threshold=1.
    expect(rows.length).toBe(2);
    const byType = Object.fromEntries(rows.map(r => [r.VERTEXTYPE, r]));
    expect(byType.concept?.SLUG).toBe(ISO_C);
    expect(byType.concept?.COMPONENTSIZE).toBe(1);
    expect(byType.tutorial?.SLUG).toBe(ISO_T);
    expect(byType.tutorial?.COMPONENTSIZE).toBe(1);
  }, 120000);

  it('flags larger components when the threshold is raised to 4', async () => {
    process.env.KG_WCC_ISOLATION_THRESHOLD = '4';
    await runKgWcc();

    const rows = await db.run(
      `SELECT VERTEXTYPE, SLUG, COMPONENTSIZE FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
      `WHERE LOWER(SLUG) LIKE ?`,
      [`${TEST_PREFIX}${RUN_ID}-%`.toLowerCase()],
    );
    // Now all six fixture vertices are flagged: two isolates (size 1)
    // + four hub vertices (size 4). Every hub row has COMPONENTSIZE=4.
    expect(rows.length).toBe(6);
    const hub = rows.filter(r => r.SLUG !== ISO_C && r.SLUG !== ISO_T);
    expect(hub.length).toBe(4);
    for (const r of hub) expect(r.COMPONENTSIZE).toBe(4);

    // Reset env so the next test isn't polluted.
    process.env.KG_WCC_ISOLATION_THRESHOLD = '1';
    await runKgWcc();
  }, 120000);

  it('surfaces isolated=true on KnowledgeGraphService.Concepts and AdminService.Tutorials', async () => {
    // Both READs go through the after('READ') decorators added in Task 4.
    // The job left the sidecar at threshold=1 from the previous test's reset.
    const kgs = await cds.connect.to(KGS);
    const admin = await cds.connect.to(AS);

    const conceptRows = await kgs.run(SELECT.from(cds.entities(KGS).Concepts).where({ slug: ISO_C }));
    expect(conceptRows.length).toBe(1);
    expect(conceptRows[0].isolated).toBe(true);

    const hubConceptRows = await kgs.run(SELECT.from(cds.entities(KGS).Concepts).where({ slug: HUB_A }));
    expect(hubConceptRows.length).toBe(1);
    // Hub is NOT isolated at threshold=1.
    expect(hubConceptRows[0].isolated === false || hubConceptRows[0].isolated == null).toBe(true);

    const tutorialRows = await admin.run(SELECT.from(cds.entities(AS).Tutorials).where({ slug: ISO_T }));
    expect(tutorialRows.length).toBe(1);
    expect(tutorialRows[0].isolated).toBe(true);
  }, 120000);
});
```

- [ ] **Step 2: Run the hybrid test**

Prerequisite: `cf login` to the DEV space, then:

```bash
ALLOW_HYBRID_WRITES=true \
  npx cds bind --exec --profile hybrid -- \
  npx vitest run --project hybrid test/hybrid/kg-wcc.test.js
```

Expected: PASS, 3 tests. If the tests hang on `beforeAll`, the fixture INSERTs are stuck — likely a stale FK or a Tutorials.legacyId collision. Check the log line and adjust the fixture slugs/legacyIds.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-wcc.test.js
git commit -m "test(#918): hybrid coverage for runKgWcc + on(READ) isolated projections"
```

---

### Task 7: CLAUDE.md gotcha + open PR

**Files:**
- Modify: `CLAUDE.md` (append one gotcha line under the KG section)

- [ ] **Step 1: Read the existing KG-related gotchas in CLAUDE.md**

Look at `CLAUDE.md` under "Top Gotchas" — the `@cap-js/ai plugin` and `KG_PAGERANK_ENABLED` bullets are the pattern to match.

- [ ] **Step 2: Append the WCC gotcha**

Add this bullet after the `KG_PAGERANK_ENABLED` bullet:

```markdown
- **`KG_WCC_ISOLATION_THRESHOLD` env var (issue #918)** — when nightly `srv/jobs/kg-wcc-job.js` runs at 04:07 UTC, it materializes rows into `KgIsolation` for concept + tutorial vertices whose weakly-connected-component size ≤ threshold. Default `1`; `0` empties the table (effectively disables the "Isolated" badge on the admin Concepts + Tutorials LRs). Compute is Node.js union-find over `KG_PG_VERTICES_V` + `KG_PG_EDGES_V` — same reason as [#916 PageRank](docs/developers/reference/kg-pagerank.md) that HANA GraphScript ships no WCC primitive (SCC yes, WCC no). Fail-quiet on every read path (missing sidecar / SELECT throw → `isolated` stays unset → no badge). Toggle: `cf set-env tutorials-srv KG_WCC_ISOLATION_THRESHOLD 2 && cf restart tutorials-srv`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#918): CLAUDE.md gotcha for KG_WCC_ISOLATION_THRESHOLD"
```

- [ ] **Step 4: Push branch and open draft PR**

```bash
git push -u origin worktree-918-kg-wcc
gh pr create --draft \
  --title "feat(#918): KG weakly-connected-components isolation flag" \
  --body "$(cat <<'EOF'
Closes #918.

Nightly Node.js union-find over `KG_PG_WORKSPACE` populates a new
`KgIsolation` sidecar; admin Concepts and Tutorials List Reports
render an "Isolated" badge on rows whose weakly-connected-component
size is ≤ `KG_WCC_ISOLATION_THRESHOLD` (default 1, env-configurable).

### Design

Spec: [`docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md`](docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md).

Compute engine: Node.js union-find. HANA GraphScript ships no WCC
primitive (per the #916 Task 0 builtins enumeration — SCC exists,
WCC does not). Templates the "cron → sidecar → Node.js compute"
shape #916 landed same day; templates the vertex-type discriminator
shape from #917's spec.

### Scope

- Concept + tutorial vertices only (issue text verbatim).
- Single sidecar keyed by `(vertexType, slug)`.
- Virtual `isolated : Boolean` on `KnowledgeGraphService.Concepts` and `AdminService.Tutorials`, populated by `after('READ')` decorators.
- Red criticality LineItem cell in both LRs; `isolated` added to `UI.SelectionFields` so curators can filter.
- Schedule: `7 4 * * *` UTC daily.

### Fail-quiet

- Missing sidecar / SELECT throw → decorator leaves `isolated` unset → no badge.
- Job failure → `kg_wcc_failures` counter; yesterday's rows stay live.
- Threshold `0` empties the table on the next nightly run.

### Testing

- `test/unit/kg-wcc-compute.test.js` — 8 pure-function tests (empty graph, isolates, single-edge union, disconnected clusters, direction-independence, self-loops, orphan edges, 100-vertex chain).
- `test/hybrid/kg-wcc.test.js` — 3 end-to-end tests seeded with an isolated/hub fixture; verifies sidecar rows, threshold-tuning behavior, and the OData projections.

### Rollout

DEV-only per the parent spike #913 non-goals. Nightly job runs dark
after merge; badge appears on admin LRs after the first nightly run.

### Non-goals

- Not visitor-facing.
- Not auto-fixing.
- Not widening to mission/group/tag/product/category vertices.
EOF
)"
```

- [ ] **Step 5: Report completion**

Print the PR URL. Task list on the plan should be all checked. Done.

---

## Self-review

**Spec coverage:**
- Q1 (Node.js union-find) → Task 1 pure core, Task 3 DB integration. ✓
- Q2 (concept + tutorial only) → Task 3 filter, Task 5 annotations only on those two entities. ✓
- Q3 (single sidecar) → Task 2 entity, Task 4 virtual + decorators. ✓
- Q4 (configurable threshold, default 1) → Task 3 `readThreshold()`, Task 6 threshold-tuning test. ✓
- Q5 (04:07 UTC) → Task 3 `registerJob` block. ✓
- Q6 (no runtime kill-switch) → not present in the plan (correct — nothing to add). ✓
- Q7 (unit + hybrid tests) → Task 1 unit, Task 6 hybrid. ✓
- Metrics (4 metrics) → Task 3 emits all four. ✓
- Env var `KG_WCC_ISOLATION_THRESHOLD` → Task 3 `readThreshold()` + Task 7 CLAUDE.md. ✓
- Rollback surfaces → not a code change; documented in spec, referenced by CLAUDE.md gotcha. ✓

**Placeholder scan:** grepped for `TBD/TODO/XXX/FIXME/…` in the plan and spec — clean.

**Type consistency:**
- `computeWcc` return shape used identically in Task 1 tests and Task 3 consumer. ✓
- `runKgWcc` return type used only for logging + tests — Task 6 destructures `{componentCount, isolatedCount}` matching the Task 3 return object. ✓
- Sidecar column names `VERTEXTYPE`/`SLUG`/`COMPONENTID`/`COMPONENTSIZE`/`COMPUTEDAT` — Task 3 INSERT uses these, Task 4 SELECT uses `VERTEXTYPE`/`SLUG`, Task 6 SELECT uses `VERTEXTYPE`/`SLUG`/`COMPONENTSIZE`. All consistent. ✓
- `isolated : Boolean` field named identically in CDS (Tasks 4-5), decorator (Task 4), annotations (Task 5), and tests (Task 6). ✓
