// srv/lib/kg-cycles.js
// Detect cycles in a `:requires` edge graph and pick the weakest edge per
// cycle for downstream auto-VETO. Pure function, no async, no external deps.
//
// Caller MUST filter edges to predicate==='requires' before passing.

/**
 * Detect cycles in a :requires edge graph.
 *
 * @param {Array<{id, source, target, predicate, confidence}>} edges
 *   `source` and `target` are concept identifiers (slug or UUID — opaque
 *   to this function; they are used as adjacency-list keys only).
 *   `confidence` is a number in [0, 1].
 *
 * @returns {{ cycles: Array<Array<edge>>, weakestEdges: string[] }}
 *   `cycles` — array of cycle paths (each is an array of edges in
 *   traversal order, length ≥ 1).
 *   `weakestEdges` — deduplicated set of edge ids to auto-VETO. The
 *   weakest edge in a cycle is the one with the lowest confidence;
 *   ties broken by lowest edge id lexicographically for determinism.
 */
export function findCycles(edges) {
  if (!edges || edges.length === 0) {
    return { cycles: [], weakestEdges: [] };
  }

  // Sort edges by id up front so DFS adjacency iteration is deterministic
  // across calls regardless of input order.
  const sortedEdges = [...edges].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  // Build adjacency list: node → [edge, ...]
  const adj = new Map();
  for (const edge of sortedEdges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source).push(edge);
  }

  const cycles = [];
  const weakestEdgeIds = new Set();

  // Self-loop pass: a length-1 cycle is its own weakest edge.
  // Doing this first means the recursive DFS doesn't have to special-case
  // the source===target back-edge.
  for (const edge of sortedEdges) {
    if (edge.source === edge.target) {
      cycles.push([edge]);
      weakestEdgeIds.add(edge.id);
    }
  }

  // DFS for cycles of length ≥ 2.
  const globalVisited = new Set();
  // recursionStack maps node → index in `pathNodes` where we entered it
  const recursionStack = new Map();
  // pathEdges[i] is the edge that was traversed to reach the (i+1)-th
  // node on the current path. Slicing from the back-reference forward
  // and appending the back-edge gives the cycle in traversal order.
  const pathEdges = [];
  const pathNodes = [];

  function dfs(node) {
    globalVisited.add(node);
    recursionStack.set(node, pathNodes.length);
    pathNodes.push(node);

    const outgoing = adj.get(node) || [];
    for (const edge of outgoing) {
      // Skip self-loops here (handled above) so we don't double-count.
      if (edge.source === edge.target) continue;

      const next = edge.target;
      if (recursionStack.has(next)) {
        // Back-edge → cycle found. Slice the path from the node we hit
        // back to the current head, then append this back-edge.
        const startIdx = recursionStack.get(next);
        const cyclePathEdges = pathEdges.slice(startIdx).concat(edge);
        cycles.push(cyclePathEdges);
        weakestEdgeIds.add(pickWeakestId(cyclePathEdges));
        continue;
      }
      if (globalVisited.has(next)) {
        // Cross-edge to a fully-explored component; not a cycle through
        // the current path.
        continue;
      }
      pathEdges.push(edge);
      dfs(next);
      pathEdges.pop();
    }

    recursionStack.delete(node);
    pathNodes.pop();
  }

  // Iterate nodes in deterministic order (sorted) so component traversal
  // is stable. We iterate over every node that appears as a source.
  const nodes = [...adj.keys()].sort();
  for (const node of nodes) {
    if (!globalVisited.has(node)) {
      dfs(node);
    }
  }

  return {
    cycles,
    weakestEdges: [...weakestEdgeIds].sort(),
  };
}

/**
 * Pick the weakest edge in a cycle. Lowest confidence wins; ties broken
 * by lowest edge id lexicographically.
 */
function pickWeakestId(cycleEdges) {
  let weakest = cycleEdges[0];
  for (let i = 1; i < cycleEdges.length; i++) {
    const candidate = cycleEdges[i];
    const cConf = Number(candidate.confidence);
    const wConf = Number(weakest.confidence);
    if (cConf < wConf || (cConf === wConf && candidate.id < weakest.id)) {
      weakest = candidate;
    }
  }
  return weakest.id;
}
