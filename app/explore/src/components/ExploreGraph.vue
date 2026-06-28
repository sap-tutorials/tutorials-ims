<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import type { ExploreNode, ExploreEdge, NodeType, PredicateType } from '../types'

const props = defineProps<{
  nodes: ExploreNode[]
  edges: ExploreEdge[]
  /** Ordered list of node IDs on the active find-path overlay. null = no overlay. */
  path?: string[] | null
}>()
const emit = defineEmits<{ nodeClick: [{ id: string; node: ExploreNode }] }>()

// Path-overlay styling. Kept here next to the edge-default palette so a
// future themer touches one file.
const PATH_EDGE_COLOR = '#ff6b35'   // SAP-friendly orange — high contrast vs the grey edges
const PATH_EDGE_SIZE = 3

const container = ref<HTMLDivElement | null>(null)
// Defeat Vue 3.5 SFC template hoisting (which makes the container ref null
// under @vue/test-utils 2.4.10 + happy-dom because the hoisted vnode is
// never attached). The binding has no runtime effect; it just signals the
// compiler to keep the vnode in the render function.
const containerLabel = computed(() => `explore-graph-${props.nodes.length}-${props.path?.length ?? 0}`)
let renderer: Sigma | null = null
let graph: Graph | null = null

onMounted(() => {
  if (!container.value) return
  graph = new Graph()
  for (const n of props.nodes) {
    graph.addNode(n.id, {
      x: Math.random(),
      y: Math.random(),
      size: 4,
      label: n.label,
      color: colorForNodeType(n.type),
      ...n,
    })
  }
  for (const e of props.edges) {
    const key = `${e.s}--${e.p}--${e.o}`
    if (!graph.hasEdge(key)) {
      graph.addEdgeWithKey(key, e.s, e.o, { type: e.p, color: edgeColorForType(e.p) })
    }
  }
  forceAtlas2.assign(graph, { iterations: 50, settings: { gravity: 1, scalingRatio: 10 } })
  renderer = new Sigma(graph, container.value, {
    minCameraRatio: 0.1,
    maxCameraRatio: 5,
  })
  renderer.on('clickNode', ({ node }) => {
    if (!graph) return
    emit('nodeClick', { id: node, node: graph.getNodeAttributes(node) as ExploreNode })
  })
  // Apply any initial path overlay (when path prop is already set on first
  // render — e.g. SSR/hydration).
  applyPathOverlay(props.path ?? null)
})

onBeforeUnmount(() => {
  renderer?.kill()
  renderer = null
  graph = null
})

// Re-apply path overlay whenever the prop changes. The watcher fires on
// both set (paint highlight) and clear (reset to default colors).
watch(() => props.path, (next) => {
  applyPathOverlay(next ?? null)
})

function applyPathOverlay(path: string[] | null): void {
  if (!graph) return
  const g = graph

  // No path → reset every edge to its default predicate color/size.
  if (!path || path.length < 2) {
    if (typeof g.forEachEdge !== 'function') return
    g.forEachEdge((key: string, attrs: any) => {
      const type = attrs?.type as PredicateType | undefined
      g.setEdgeAttribute(key, 'color', type ? edgeColorForType(type) : '#999999')
      g.setEdgeAttribute(key, 'size', 1)
    })
    renderer?.refresh?.()
    return
  }

  // Collect the edge keys connecting consecutive path-node pairs. Use
  // forEachEdge(s, o, cb) so the lookup tolerates parallel edges between
  // the same two nodes (multiple predicate types).
  const pathEdgeKeys = new Set<string>()
  for (let i = 0; i < path.length - 1; i++) {
    const s = path[i]
    const o = path[i + 1]
    if (typeof g.forEachEdge !== 'function') break
    // graphology forEachEdge(source, target, cb) iterates both directions
    // on undirected graphs and source→target only on directed graphs;
    // explore graphs are directed (subject → object), so also probe the
    // reverse direction for predicates that surface as the inverse.
    g.forEachEdge(s, o, (key: string) => {
      pathEdgeKeys.add(key)
    })
    g.forEachEdge(o, s, (key: string) => {
      pathEdgeKeys.add(key)
    })
  }

  if (typeof g.forEachEdge !== 'function') return
  g.forEachEdge((key: string, attrs: any) => {
    if (pathEdgeKeys.has(key)) {
      g.setEdgeAttribute(key, 'color', PATH_EDGE_COLOR)
      g.setEdgeAttribute(key, 'size', PATH_EDGE_SIZE)
    } else {
      const type = attrs?.type as PredicateType | undefined
      g.setEdgeAttribute(key, 'color', type ? edgeColorForType(type) : '#999999')
      g.setEdgeAttribute(key, 'size', 1)
    }
  })

  // Camera-fit to the bounding box of path nodes (#693). Compute the min/max
  // x/y across all path-node graphology attributes, then animate the camera
  // to the center with a `ratio` derived from the bounding-box span so the
  // path occupies most of the viewport. `ratio` < 1 zooms in; 0 is fully
  // zoomed in. We pad by ~30% (multiplier 0.7) so the highlighted edges
  // aren't pressed against the viewport edges. Falls back to animatedReset()
  // if any path node lacks numeric x/y (test mocks, malformed nodes).
  try {
    const camera = renderer?.getCamera?.()
    if (!camera || typeof g.getNodeAttribute !== 'function') {
      camera?.animatedReset?.()
    } else {
      const xs: number[] = []
      const ys: number[] = []
      for (const id of path) {
        const x = g.getNodeAttribute(id, 'x')
        const y = g.getNodeAttribute(id, 'y')
        if (Number.isFinite(x)) xs.push(x as number)
        if (Number.isFinite(y)) ys.push(y as number)
      }
      if (xs.length >= 2 && ys.length >= 2) {
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)
        const centerX = (minX + maxX) / 2
        const centerY = (minY + maxY) / 2
        // ratio is roughly half the span — with the 0.7 padding multiplier the
        // path fills ~70% of the viewport. Floor at 0.1 so tightly-clustered
        // paths don't zoom in past Sigma's default minCameraRatio.
        const span = Math.max(maxX - minX, maxY - minY)
        const ratio = Math.max(0.1, (span / 2) * 0.7)
        // Sigma v3's `camera.animate({x, y, ratio}, {duration})` returns a
        // promise; we don't await it because the next reactive change should
        // be allowed to interrupt the animation cleanly.
        camera.animate?.({ x: centerX, y: centerY, ratio }, { duration: 600 })
      } else {
        // Not enough numeric coords (likely a test mock); use the safe fallback.
        camera.animatedReset?.()
      }
    }
  } catch {
    // No-op if Sigma's camera API isn't available in the current test mock.
  }
  renderer?.refresh?.()
}

function colorForNodeType(t: NodeType): string {
  return NODE_COLORS[t]
}

function edgeColorForType(p: PredicateType): string {
  return EDGE_COLORS[p]
}

// Drift-resistant: Record<NodeType, string> makes TS catch missing variants.
const NODE_COLORS: Record<NodeType, string> = {
  tutorial: '#0a6ed1',
  concept:  '#107e3e',
  mission:  '#df6e0c',
  product:  '#a100c2',
  group:    '#8c8c8c',
  category: '#666666',
  tag:      '#888888',
}

const EDGE_COLORS: Record<PredicateType, string> = {
  teaches:         '#999999',
  requires:        '#999999',
  relatedTo:       '#999999',
  extends:         '#999999',
  partOf:          '#999999',
  taggedWith:      '#999999',
  aboutProduct:    '#999999',
  inCategory:      '#999999',
  coCompletedWith: '#cccccc',
}
</script>

<template>
  <div ref="container" class="explore-graph" :data-graph-id="containerLabel" />
</template>

<style scoped>
.explore-graph {
  width: 100%;
  height: 100%;
  min-height: 600px;
}
</style>
