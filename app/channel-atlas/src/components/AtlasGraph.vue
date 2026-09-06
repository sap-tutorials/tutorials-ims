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
let themeObserver: MutationObserver | null = null

// Read the site theme's text color (from --sapTextColor, flipped by the
// html.dark class). Sigma bakes labelColor into its settings at construction,
// so we resolve the current value each buildGraph() and rebuild on theme flip.
function themeLabelColor(): string {
  if (typeof window === 'undefined') return '#32363a'
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--sapTextColor')
    .trim()
  return v || '#32363a'
}

onMounted(() => {
  buildGraph()
  // Update baked Sigma label color when the site theme toggles (html.dark class
  // add/remove) — a lightweight setting refresh, not a full rebuild, so the
  // forceAtlas2 layout is preserved. Guarded for non-browser (unit) env.
  if (typeof window !== 'undefined' && 'MutationObserver' in window) {
    themeObserver = new MutationObserver(() => {
      if (renderer) {
        renderer.setSetting('labelColor', { color: themeLabelColor() })
        renderer.refresh()
      }
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }
})

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

  renderer = new Sigma(graph, container.value, {
    labelColor: { color: themeLabelColor() },
  })
  renderer.on('clickNode', ({ node }) => {
    const atlasNode = props.nodes.find((n) => n.id === node)
    if (atlasNode) emit('nodeClick', { id: node, node: atlasNode })
  })
}

onBeforeUnmount(() => {
  if (themeObserver) { themeObserver.disconnect(); themeObserver = null }
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
