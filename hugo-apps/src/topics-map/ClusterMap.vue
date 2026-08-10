<script setup lang="ts">
/**
 * hugo-apps/src/topics-map/ClusterMap.vue
 *
 * Sigma.js 3 graph render for the Topics Cluster Map island.
 *
 * Super-graph: nodes are cluster super-nodes (type='cluster'), sized by
 * `size`, colored by a stable hue derived from the slug. Edge thickness
 * proportional to weight.
 *
 * Click a super-node → fetch /graph/clusters-data?cluster=<slug>,
 * add its concept child-nodes, dim all other clusters (expand-in-place).
 *
 * "See full graph →" links to /explore/?focus=<firstConceptSlug> (Task 10).
 *
 * Progressive enhancement guard: onMounted checks container dimensions.
 * If the container has zero size (jsdom in tests, or an invisible section)
 * Sigma init is skipped entirely — no WebGL context errors.
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { MultiDirectedGraph } from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';

interface ClusterNode {
  id: string;
  type: 'cluster';
  slug: string;
  label: string;
  size: number;
}

interface ClusterEdge {
  s: string;
  o: string;
  weight: number;
}

interface ConceptNode {
  id: string;
  type: 'concept';
  slug: string;
  label: string;
}

const props = defineProps<{
  nodes: ClusterNode[];
  edges: ClusterEdge[];
  focusCluster: string;
}>();

const container = ref<HTMLDivElement | null>(null);

let renderer: Sigma | null = null;
let graph: MultiDirectedGraph | null = null;

// Track which clusters have been expanded (concepts loaded).
const expandedClusters = new Set<string>();
// Track the currently highlighted/expanded cluster slug for UI.
const activeCluster = ref<string>('');
// First concept slug of the active cluster (for "See full graph →").
const firstConceptSlug = ref<string>('');

// --- Stable hue from slug (djb2 hash) ---
function slugToHue(slug: string): number {
  let hash = 5381;
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) + hash) ^ slug.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash % 360;
}

function clusterColor(slug: string): string {
  const hue = slugToHue(slug);
  return `hsl(${hue}, 60%, 45%)`;
}

const CONCEPT_COLOR = '#107e3e';
const DIMMED_COLOR = '#d0d0d0';
const DEFAULT_NODE_SIZE = 10;

// Build the initial super-graph.
function buildGraph(): void {
  if (!container.value) return;

  // Zero-size guard: jsdom has no layout engine, so offsetWidth/Height === 0.
  // Sigma requires a sized container for WebGL canvas creation. Skip init
  // gracefully so unit tests (which mount in jsdom) never hit a WebGL error.
  if (container.value.offsetWidth === 0 && container.value.offsetHeight === 0) {
    return;
  }

  renderer?.kill();
  renderer = null;
  graph = null;
  expandedClusters.clear();
  activeCluster.value = '';
  firstConceptSlug.value = '';

  graph = new MultiDirectedGraph();

  for (const n of props.nodes) {
    graph.addNode(n.id, {
      x: Math.random(),
      y: Math.random(),
      size: Math.max(4, n.size),
      label: n.label,
      color: clusterColor(n.slug),
      slug: n.slug,
      nodeType: 'cluster',
    });
  }

  for (const e of props.edges) {
    const key = `${e.s}--${e.o}`;
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, e.s, e.o, {
        size: Math.max(1, Math.round(e.weight * 3)),
        color: '#cccccc',
      });
    }
  }

  forceAtlas2.assign(graph, { iterations: 50, settings: { gravity: 1, scalingRatio: 10 } });

  renderer = new Sigma(graph, container.value, {
    minCameraRatio: 0.05,
    maxCameraRatio: 5,
    // Force built-in circle program for every node regardless of stored nodeType.
    nodeReducer: (_node, data) => ({ ...data, type: 'circle' }),
    // Force built-in line program for every edge regardless of stored type.
    edgeReducer: (_edge, data) => ({ ...data, type: 'line' }),
  });

  renderer.on('clickNode', ({ node }) => {
    if (!graph) return;
    const attrs = graph.getNodeAttributes(node);
    if (attrs.nodeType === 'cluster') {
      expandCluster(attrs.slug as string, node);
    }
  });

  // Auto-expand focus cluster (cluster-detail mini-map).
  if (props.focusCluster) {
    const focusNodeId = `c:${props.focusCluster}`;
    if (graph.hasNode(focusNodeId)) {
      expandCluster(props.focusCluster, focusNodeId);
    }
  }
}

// Expand a cluster: fetch concept children, add to graph, dim others.
async function expandCluster(slug: string, nodeId: string): Promise<void> {
  if (!graph) return;

  activeCluster.value = slug;
  firstConceptSlug.value = '';

  // Dim all other cluster nodes.
  graph.forEachNode((id: string, attrs: any) => {
    if (id !== nodeId && attrs.nodeType === 'cluster') {
      graph!.setNodeAttribute(id, 'color', DIMMED_COLOR);
    }
  });

  // If already expanded, just re-highlight and refresh.
  if (expandedClusters.has(slug)) {
    // Re-show any concept children belonging to this cluster.
    graph.forEachNode((id: string, attrs: any) => {
      if (attrs.parentCluster === slug) {
        graph!.setNodeAttribute(id, 'color', CONCEPT_COLOR);
        firstConceptSlug.value ||= attrs.slug as string;
      }
    });
    renderer?.refresh?.();
    return;
  }

  try {
    const res = await fetch(`/graph/clusters-data?cluster=${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data: { nodes: ConceptNode[]; edges: unknown[] } = await res.json();

    // Position child-nodes near the parent cluster node.
    const parentX: number = graph.getNodeAttribute(nodeId, 'x') as number ?? 0;
    const parentY: number = graph.getNodeAttribute(nodeId, 'y') as number ?? 0;

    for (const n of data.nodes) {
      if (!graph.hasNode(n.id)) {
        const angle = Math.random() * 2 * Math.PI;
        const r = 0.1 + Math.random() * 0.15;
        graph.addNode(n.id, {
          x: parentX + r * Math.cos(angle),
          y: parentY + r * Math.sin(angle),
          size: 4,
          label: n.label,
          color: CONCEPT_COLOR,
          slug: n.slug,
          nodeType: 'concept',
          parentCluster: slug,
        });
        if (!firstConceptSlug.value) {
          firstConceptSlug.value = n.slug;
        }
      }
    }

    expandedClusters.add(slug);
    renderer?.refresh?.();
  } catch {
    // Fetch failed — leave graph as-is.
  }
}

onMounted(() => {
  buildGraph();
});

// Rebuild graph when node/edge props change (parent re-fetch).
watch([() => props.nodes, () => props.edges], () => {
  buildGraph();
});

onBeforeUnmount(() => {
  renderer?.kill();
  renderer = null;
  graph = null;
});
</script>

<template>
  <div class="topics-cluster-map">
    <div ref="container" class="topics-cluster-map__canvas" />
    <div v-if="activeCluster && firstConceptSlug" class="topics-cluster-map__actions">
      <a
        class="topics-cluster-map__full-graph-link"
        :href="`/explore/?focus=${encodeURIComponent(firstConceptSlug)}`"
      >
        See full graph &rarr;
      </a>
    </div>
  </div>
</template>

<style scoped>
.topics-cluster-map {
  position: relative;
  width: 100%;
  height: 420px;
}

.topics-cluster-map__canvas {
  width: 100%;
  height: 100%;
}

.topics-cluster-map__actions {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 10;
}

.topics-cluster-map__full-graph-link {
  display: inline-block;
  padding: 6px 14px;
  background: #0a6ed1;
  color: #fff;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.875rem;
}

.topics-cluster-map__full-graph-link:hover {
  background: #0854a0;
}
</style>
