// srv/lib/kg-clusters-data.js
//
// Pure builder for the /graph/clusters-data endpoint.
// Reuses buildTopicsGalleryPayload (Task 5) — no new DB reads of its own.
//
// buildClustersDataPayload(db) -> { nodes, edges, generatedAt }
//   nodes: one super-node per ACTIVE non-hidden cluster  { id:'c:<slug>', type:'cluster', slug, label, size }
//   edges: inter-cluster edges (DEDUPED)                 { s:'c:<slugA>', o:'c:<slugB>', weight }
//
// buildClusterSubgraph(db, slug) -> { nodes, edges }
//   nodes: top concepts of the cluster as concept nodes  { id:'t:<conceptSlug>', type:'concept', slug, label }
//   edges: [] (v1 — concept-order path edges optional)
//
// Node id convention mirrors /graph/explore-data: prefix:slug.
// Edge fields s/o/weight match the existing explore-data convention.
//
// Issue: topics-discovery SDD Task 8

import { buildTopicsGalleryPayload } from './build-topics-gallery.js';

export async function buildClustersDataPayload(db) {
  const { gallery, clusters } = await buildTopicsGalleryPayload(db);

  // One super-node per gallery item (gallery is already filtered to ACTIVE non-hidden)
  const nodes = gallery.map((c) => ({
    id: `c:${c.slug}`,
    type: 'cluster',
    slug: c.slug,
    label: c.label,
    size: c.memberCount || 1,
  }));

  // Inter-cluster edges — deduplicated so each pair appears once
  const seen = new Set();
  const edges = [];
  for (const c of gallery) {
    const detail = clusters[c.slug];
    for (const p of detail?.peers || []) {
      const key = c.slug < p.slug ? `${c.slug}|${p.slug}` : `${p.slug}|${c.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ s: `c:${c.slug}`, o: `c:${p.slug}`, weight: p.weight });
    }
  }

  return { nodes, edges, generatedAt: new Date().toISOString() };
}

export async function buildClusterSubgraph(db, slug) {
  const { clusters } = await buildTopicsGalleryPayload(db);
  const detail = clusters[slug];
  if (!detail) return { nodes: [], edges: [] };

  // Top concepts as concept nodes (up to 30 — consistent with island expand-in-place budget)
  const nodes = detail.concepts.slice(0, 30).map((c) => ({
    id: `t:${c.slug}`,
    type: 'concept',
    slug: c.slug,
    label: c.name,
  }));

  // v1: edges are empty; requires-path edges can be wired in a later task
  // by extending build-topics-gallery to expose cluster pathEdges.
  return { nodes, edges: [] };
}

export default { buildClustersDataPayload, buildClusterSubgraph };
