<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import type { ExploreNode, ExploreEdge, NodeType, PredicateType } from '../types'

const props = defineProps<{ nodes: ExploreNode[]; edges: ExploreEdge[] }>()
const emit = defineEmits<{ nodeClick: [{ id: string; node: ExploreNode }] }>()

const container = ref<HTMLDivElement | null>(null)
// Defeat Vue 3.5 SFC template hoisting (which makes the container ref null
// under @vue/test-utils 2.4.10 + happy-dom because the hoisted vnode is
// never attached). The binding has no runtime effect; it just signals the
// compiler to keep the vnode in the render function.
const containerLabel = computed(() => `explore-graph-${props.nodes.length}`)
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
})

onBeforeUnmount(() => {
  renderer?.kill()
  renderer = null
  graph = null
})

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
