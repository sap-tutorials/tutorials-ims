<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { MultiDirectedGraph } from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import type { AtlasNode, AtlasEdge } from '../types.js'
import { ownerTypeColor } from '../graph.js'

const props = defineProps<{
  nodes: AtlasNode[]
  edges: AtlasEdge[]
}>()

const emit = defineEmits<{
  nodeClick: [{ id: string; node: AtlasNode }]
}>()

const container = ref<HTMLDivElement | null>(null)
// Defeat Vue 3.5 SFC template hoisting (see ExploreGraph.vue#containerLabel comment).
const containerLabel = computed(() => `atlas-graph-${props.nodes.length}`)

let renderer: InstanceType<typeof Sigma> | null = null

onMounted(() => { buildGraph() })

// Rebuild on prop changes — mirrors app/explore/src/components/ExploreGraph.vue.
// deep:false — computed always produces a new array reference.
watch(
  [() => props.nodes, () => props.edges],
  () => { buildGraph() },
)

function buildGraph() {
  if (renderer) { renderer.kill(); renderer = null }
  if (!container.value) return

  const graph = new MultiDirectedGraph()

  for (const n of props.nodes) {
    graph.addNode(n.id, {
      x: Math.random(),
      y: Math.random(),
      size: n.size,
      color: n.color ?? ownerTypeColor(n.ownerType),
      label: n.name,
    })
  }

  const seen = new Set<string>()
  for (const e of props.edges) {
    // Dedup key: source:kind:target (same pair can appear for both 'focus' and 'topic')
    const key = `${e.source}:${e.kind}:${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    try {
      graph.addEdgeWithKey(key, e.source, e.target, {
        size: Math.max(1, e.weight * 0.5),
        color: e.kind === 'topic' ? '#5dc122' : '#cccccc',
      })
    } catch (_) { /* duplicate key — skip silently */ }
  }

  forceAtlas2.assign(graph, {
    iterations: 100,
    settings: { gravity: 1, scalingRatio: 10, barnesHutOptimize: true },
  })

  renderer = new Sigma(graph, container.value)
  renderer.on('clickNode', ({ node }) => {
    const atlasNode = props.nodes.find((n) => n.id === node)
    if (atlasNode) emit('nodeClick', { id: node, node: atlasNode })
  })
}

onBeforeUnmount(() => {
  if (renderer) { renderer.kill(); renderer = null }
})

defineExpose({ containerLabel })
</script>

<template>
  <div
    ref="container"
    class="atlas-graph"
    :data-graph-id="containerLabel"
  />
</template>

<style scoped>
.atlas-graph {
  width: 100%;
  height: 100%;
}
</style>
