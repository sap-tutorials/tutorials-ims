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
// eslint-disable-next-line no-unused-vars
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
