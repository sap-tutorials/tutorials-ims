// Pure suggested-order sort for a cluster's concepts.
// Kahn topological sort over in-cluster `requires` edges; PageRank breaks ties
// and cycles; falls back to pure PageRank order when the requires subgraph is thin.

export function orderConcepts({ concepts = [], requiresEdges = [], rankBySlug = new Map() }) {
  const inCluster = new Set(concepts.map((c) => c.slug));
  const rank = (s) => rankBySlug.get(s) || 0;
  const bySlug = new Map(concepts.map((c) => [c.slug, c]));

  // Restrict edges to in-cluster concept pairs. source requires target => target first.
  const edges = requiresEdges.filter((e) => inCluster.has(e.source) && inCluster.has(e.target) && e.source !== e.target);
  const rankedFallback = [...concepts].sort((a, b) => rank(b.slug) - rank(a.slug));

  const threshold = Math.max(2, Math.floor(concepts.length / 4));
  if (edges.length < threshold) {
    return { ordered: rankedFallback, mode: 'ranked' };
  }

  // Build indegree from prerequisite -> dependent (target -> source).
  const dependents = new Map();  // prereq -> [dependents]
  const indeg = new Map(concepts.map((c) => [c.slug, 0]));
  for (const e of edges) {
    if (!dependents.has(e.target)) dependents.set(e.target, []);
    dependents.get(e.target).push(e.source);
    indeg.set(e.source, (indeg.get(e.source) || 0) + 1);
  }

  // Kahn with a PageRank-desc ready queue (stable, deterministic).
  const ready = concepts.filter((c) => (indeg.get(c.slug) || 0) === 0).map((c) => c.slug);
  const pick = (arr) => { arr.sort((x, y) => rank(y) - rank(x)); return arr.shift(); };
  const ordered = [];
  const placed = new Set();
  while (ready.length) {
    const slug = pick(ready);
    if (placed.has(slug)) continue;
    placed.add(slug);
    ordered.push(bySlug.get(slug));
    for (const dep of dependents.get(slug) || []) {
      indeg.set(dep, (indeg.get(dep) || 0) - 1);
      if ((indeg.get(dep) || 0) <= 0 && !placed.has(dep)) ready.push(dep);
    }
  }
  // Cycle remainder: append any unplaced concepts in PageRank-desc order.
  for (const c of rankedFallback) if (!placed.has(c.slug)) { ordered.push(c); placed.add(c.slug); }

  return { ordered, mode: 'path' };
}
