<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import type { ExploreNode, ExploreEdge } from '../types'

const props = defineProps<{ nodes: ExploreNode[]; edges: ExploreEdge[] }>()
const emit = defineEmits<{ nodeClick: [{ id: string; node: ExploreNode }] }>()

const container = ref<HTMLDivElement | null>(null)
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

function colorForNodeType(t: string) {
  switch (t) {
    case 'tutorial': return '#0a6ed1'
    case 'concept':  return '#107e3e'
    case 'mission':  return '#df6e0c'
    case 'product':  return '#a100c2'
    case 'group':    return '#8c8c8c'
    case 'category': return '#666666'
    case 'tag':      return '#888888'
    default:         return '#000'
  }
}

function edgeColorForType(p: string) {
  return p === 'coCompletedWith' ? '#cccccc' : '#999999'
}
</script>

<template>
  <div ref="container" class="explore-graph" />
</template>

<style scoped>
.explore-graph {
  width: 100%;
  height: 100%;
  min-height: 600px;
}
</style>
