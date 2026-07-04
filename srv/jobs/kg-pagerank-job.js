// srv/jobs/kg-pagerank-job.js
// ============================================================
// Nightly PageRank pass over KG_PG_WORKSPACE, materialized into
// ConceptRank + TutorialRank sidecar tables.
//
// COMPUTE PATH (Option C, decided with Tom 2026-07-04 after Task 0):
// HANA GraphScript has no PageRank primitive — enumerated the full
// BUILTIN_FUNCTIONS_ALGORITHMS set in SAP-samples/hana-graph-examples
// and confirmed neither PAGE_RANK / Compute_PageRank / PageRank spelling
// is recognized (see the Task 0 notes:
// docs/superpowers/reviews/2026-07-04-916-kg-pagerank-task0-notes.md).
// PageRank is computed here in Node.js against 40k edges pulled from
// KG_PG_EDGES_V; iterative fixed-point on a Float64Array converges in
// ~30-50 iterations at DEV scale in well under a second.
//
// GRAPH ORIENTATION
// The workspace's edges are directed (concept→concept for `requires`,
// tutorial→concept for `teaches`). But every request-time consumer
// (KG_SHORTEST_PATH_GRAPH walks direction 'ANY') treats the KG as an
// undirected navigation surface. To match, this PageRank runs on the
// undirected projection: for each edge (u, v) we contribute rank both
// ways. That's what makes a hub concept — high in-degree in the RDF
// sense — actually score high when the whatToLearnNext ranker looks
// it up.
//
// DANGLING NODES
// Vertices with degree 0 (e.g. a fresh concept nobody has linked to
// yet) get the mean-rank redistribution treatment: each iteration's
// dangling mass is spread uniformly across N so the total stays 1.
//
// FAIL-OPEN SEMANTICS
// This job's failure never breaks request-time reads: the ranker in
// knowledge-graph-service.js catches any loadRankMaps() throw and
// collapses the multiplier to 1.0. So if this job errors, the DB
// keeps yesterday's scores (or empty tables) and the sidebar behaves
// as if KG_PAGERANK_ENABLED were off.
//
// TRANSACTION SHAPE
// TRUNCATE + TRUNCATE + INSERT-batches are wrapped in one db.tx. If
// the middle of the batch loop throws (e.g. HANA deadlock, network
// blip), the whole thing rolls back and yesterday's scores stay
// visible. No partial write is ever observable to a reader.
//
// Registered by srv/jobs/scheduler.js at 03:53 UTC.
//
// Spec:  docs/superpowers/specs/2026-07-04-916-kg-pagerank-design.md
// Issue: #916 (prereq #919 delivered a widened KG_PG_EDGES_V that
//        includes coCompletedWith — 20,496 rows at cutover time,
//        materially larger than the other predicates combined).
// ============================================================

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const LOG = cds.log('kg-pagerank');

// HANA table names for the sidecars (bytecode names emitted by CAP for
// the ConceptRank / TutorialRank CDS entities in db/knowledge-graph.cds).
// Verified against the Task 1 deploy on DEV HDI 2026-07-04.
const CONCEPT_RANK_TABLE  = '"COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"';
const TUTORIAL_RANK_TABLE = '"COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"';

// PageRank tuning. Match the RDF-native mental model (α=0.85 is the
// classic Brin-Page choice, cited by every reference implementation
// including HANA's own graph-tour blog samples). Tolerance is L1
// difference on the rank vector — 1e-6 across 6k concepts + 800
// tutorials means individual rank changes below ~1.7e-10, well below
// the precision the ranker cares about.
const DAMPING = 0.85;
const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-6;

// Batch insert size — same as materialize-co-completions.js (500).
// A concept vertex row is a slug (up to 80B) + a Double (8B) + a
// timestamp; each batch is well under HANA's 32MB statement cap.
const INSERT_BATCH_SIZE = 500;

// ============================================================
// Pure-function core — PageRank on an undirected graph.
//
// Exposed as an export so the hybrid test can build a hub-and-spoke
// fixture and inspect the score ordering without the DB round-trip.
// (The DB-integrated path in runKgPageRank drives the same function
// against KG_PG_EDGES_V — no algorithmic divergence.)
// ============================================================

/**
 * Compute undirected PageRank over an edge list.
 *
 * @param {string[]} vertices — vertex keys (from KG_PG_VERTICES_V.VERTEX_KEY).
 * @param {Array<[string,string]>} edges — [source, target] pairs
 *   (from KG_PG_EDGES_V). Direction is ignored — each edge contributes
 *   to both endpoints' degree. Self-loops are treated as a single
 *   endpoint (skipped in the adjacency build).
 * @param {object} [opts]
 * @param {number} [opts.damping=0.85] — teleport probability = 1 - damping.
 * @param {number} [opts.maxIterations=100] — hard cap.
 * @param {number} [opts.tolerance=1e-6] — L1-norm convergence threshold.
 * @returns {{rank: Map<string, number>, iterations: number, converged: boolean}}
 *   `rank` maps vertex-key → score in [0, 1] summing to ~1.0.
 */
export function computePageRank(vertices, edges, opts = {}) {
  const damping = opts.damping ?? DAMPING;
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const tolerance = opts.tolerance ?? TOLERANCE;

  const N = vertices.length;
  if (N === 0) {
    return { rank: new Map(), iterations: 0, converged: true };
  }

  // Map vertex-key → dense index. The rank vector is a Float64Array
  // indexed by this position so the inner loop is a tight numeric scan.
  const indexOf = new Map();
  for (let i = 0; i < N; i++) indexOf.set(vertices[i], i);

  // Undirected adjacency: adj[i] = flat array of neighbor indices.
  // Building as arrays first, then freezing to Int32Array per row keeps
  // the hot inner loop typed-array cache-friendly. Duplicate edges are
  // preserved (they weight the neighbor accordingly — HANA's
  // coCompletedWith predicate never emits duplicates, but requires+teaches
  // can theoretically overlap on the same pair; we treat those as extra
  // signal, not dedup).
  const adjBuild = Array.from({ length: N }, () => []);
  let selfLoops = 0;
  let danglingOrphans = 0;
  for (const [src, dst] of edges) {
    const i = indexOf.get(src);
    const j = indexOf.get(dst);
    if (i === undefined || j === undefined) {
      // Edge references a vertex not in the vertex set. Should never
      // happen for KG_PG_EDGES_V vs KG_PG_VERTICES_V (both derive from
      // ConceptEdges + TutorialConceptLinks with FK integrity) but guard
      // anyway — a dangling edge would corrupt degree counts.
      danglingOrphans++;
      continue;
    }
    if (i === j) { selfLoops++; continue; }
    adjBuild[i].push(j);
    adjBuild[j].push(i);
  }
  const adj = adjBuild.map(list => Int32Array.from(list));
  const degree = new Int32Array(N);
  for (let i = 0; i < N; i++) degree[i] = adj[i].length;

  // Uniform initial rank 1/N.
  const initial = 1 / N;
  let rank = new Float64Array(N).fill(initial);
  let next = new Float64Array(N);
  const teleport = (1 - damping) / N;

  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations++) {
    // Dangling mass: sum of ranks on zero-degree vertices, redistributed
    // uniformly. Without this, iterating a graph with any degree-0 nodes
    // leaks probability mass and the rank vector doesn't sum to 1.
    let danglingMass = 0;
    for (let i = 0; i < N; i++) {
      if (degree[i] === 0) danglingMass += rank[i];
    }
    const danglingContribution = damping * danglingMass / N;

    // Reset next[] and stage the base contribution (teleport + dangling
    // spread). The neighbor loop then adds directed rank contributions.
    const base = teleport + danglingContribution;
    for (let i = 0; i < N; i++) next[i] = base;

    // Push each non-dangling vertex's rank/degree contribution to its
    // neighbors. Undirected adjacency means each edge already appears
    // in both endpoints' adj[], so we only push in one direction here.
    for (let i = 0; i < N; i++) {
      const d = degree[i];
      if (d === 0) continue;
      const contribution = damping * rank[i] / d;
      const neighbors = adj[i];
      for (let k = 0; k < neighbors.length; k++) {
        next[neighbors[k]] += contribution;
      }
    }

    // L1 convergence check.
    let l1 = 0;
    for (let i = 0; i < N; i++) l1 += Math.abs(next[i] - rank[i]);

    // Swap-and-continue. Using two buffers avoids allocating a new
    // Float64Array per iteration.
    const tmp = rank; rank = next; next = tmp;

    if (l1 < tolerance) { converged = true; iterations++; break; }
  }

  // Materialize the final rank vector into a Map<vertex-key, score>.
  const out = new Map();
  for (let i = 0; i < N; i++) out.set(vertices[i], rank[i]);
  return { rank: out, iterations, converged, selfLoops, danglingOrphans };
}

// ============================================================
// DB-integrated entry point — the scheduler calls this.
// ============================================================

export async function runKgPageRank() {
  const t0 = Date.now();
  const db = await cds.connect.to('db');

  try {
    // 1. Load vertices + edges from the workspace views. These are the
    //    same rows the (nonexistent) GraphScript primitive would have
    //    seen — pulling them client-side is the whole point of Option C.
    const vertexRows = await db.run(
      'SELECT VERTEX_KEY, VERTEX_TYPE, SLUG FROM KG_PG_VERTICES_V',
    );
    const edgeRows = await db.run(
      'SELECT "SOURCE", "TARGET" FROM KG_PG_EDGES_V',
    );
    const readMs = Date.now() - t0;

    // 2. Compute PageRank. Undirected, standard damping 0.85.
    const vertexKeys = vertexRows.map(r => r.VERTEX_KEY);
    const edges = edgeRows.map(r => [r.SOURCE, r.TARGET]);
    const t1 = Date.now();
    const { rank, iterations, converged, selfLoops, danglingOrphans } =
      computePageRank(vertexKeys, edges);
    const computeMs = Date.now() - t1;

    if (!converged) {
      LOG.warn(
        `PageRank did not converge in ${iterations} iterations ` +
        `(tolerance ${TOLERANCE}); using best-effort rank`,
      );
    }
    if (selfLoops > 0 || danglingOrphans > 0) {
      LOG.info(
        `PageRank sanitization: ${selfLoops} self-loops skipped, ` +
        `${danglingOrphans} orphan edges skipped (source/target missing from vertex set)`,
      );
    }

    // 3. Split scores by vertex type. Only 'concept' and 'tutorial' rows
    //    are consumed by the ranker; the other types (tag, mission,
    //    group, category) contribute rank in the graph but their scores
    //    aren't materialized to sidecars because no ranker call site
    //    looks them up.
    const now = new Date().toISOString();
    const conceptRows = [];
    const tutorialRows = [];
    for (const v of vertexRows) {
      const score = rank.get(v.VERTEX_KEY);
      if (score === undefined || !Number.isFinite(score)) continue;
      // v.SLUG may be null for legacy rows — guard the ranker key.
      if (!v.SLUG) continue;
      if (v.VERTEX_TYPE === 'concept') {
        conceptRows.push({ slug: v.SLUG, score, computedAt: now });
      } else if (v.VERTEX_TYPE === 'tutorial') {
        tutorialRows.push({ slug: v.SLUG, score, computedAt: now });
      }
    }

    // 4. Atomic swap in one tx: TRUNCATE + TRUNCATE + batched INSERTs.
    //    If the batch loop throws mid-way, HANA rolls back to yesterday's
    //    scores — readers never see a partial state.
    const t2 = Date.now();
    const { ConceptRank, TutorialRank } = cds.entities('com.sap.developers.ims');
    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${CONCEPT_RANK_TABLE}`);
      await tx.run(`TRUNCATE TABLE ${TUTORIAL_RANK_TABLE}`);
      for (let i = 0; i < conceptRows.length; i += INSERT_BATCH_SIZE) {
        const batch = conceptRows.slice(i, i + INSERT_BATCH_SIZE);
        await tx.run(INSERT.into(ConceptRank).entries(batch));
      }
      for (let i = 0; i < tutorialRows.length; i += INSERT_BATCH_SIZE) {
        const batch = tutorialRows.slice(i, i + INSERT_BATCH_SIZE);
        await tx.run(INSERT.into(TutorialRank).entries(batch));
      }
    });
    const writeMs = Date.now() - t2;

    const durationMs = Date.now() - t0;
    metrics.observe('kg_pagerank_duration_ms', durationMs);
    metrics.gauge('kg_pagerank_nodes_scored', conceptRows.length + tutorialRows.length);

    LOG.info(
      `PageRank: ${vertexKeys.length} vertices / ${edges.length} edges → ` +
      `${conceptRows.length} concepts + ${tutorialRows.length} tutorials scored ` +
      `(iterations=${iterations}, converged=${converged}, ` +
      `read=${readMs}ms, compute=${computeMs}ms, write=${writeMs}ms, total=${durationMs}ms)`,
    );

    return {
      conceptsScored: conceptRows.length,
      tutorialsScored: tutorialRows.length,
      iterations,
      converged,
      readMs,
      computeMs,
      writeMs,
      durationMs,
    };
  } catch (err) {
    metrics.counter('kg_pagerank_failures');
    LOG.error('PageRank job failed', err);
    throw err;
  }
}
