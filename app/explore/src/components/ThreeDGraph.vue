<template>
  <div
    ref="container"
    class="threed-graph"
    data-graph-id="explore-3d"
  />
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { ExploreNode, ExploreEdge } from '../types'
import { toGraphData } from './threed-graph-data'

// ---------------------------------------------------------------------------
// Props / emits
// ---------------------------------------------------------------------------
const props = defineProps<{
  nodes: ExploreNode[]
  edges: ExploreEdge[]
}>()

const emit = defineEmits<{
  nodeClick: [payload: { id: string; node: ExploreNode }]
}>()

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------
const container = ref<HTMLElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let graph: any = null

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  if (!container.value) return

  // Dynamic import keeps three/d3-force-3d out of the entry chunk (load-bearing —
  // do NOT convert to a static import).
  const mod = await import('3d-force-graph')
  const ForceGraph3D = mod.default

  graph = ForceGraph3D()(container.value)
    .graphData(toGraphData(props.nodes, props.edges))
    // Node appearance
    .nodeColor((n: any) => n.color)
    .nodeVal((n: any) => n.val)
    .nodeLabel((n: any) => `${n.label} (${n.type})`)
    // Directed arrows
    .linkDirectionalArrowLength(3)
    .linkDirectionalArrowRelPos(1)
    // Particles on requires/teaches edges
    .linkDirectionalParticles((l: any) =>
      l.predicate === 'requires' || l.predicate === 'teaches' ? 2 : 0
    )
    .linkDirectionalParticleSpeed(0.006)
    // Link colour
    .linkColor((l: any) => l.color)
    // Background
    .backgroundColor('#0a0e17')
    // Node click: emit + camera fly-to
    .onNodeClick((n: any) => {
      emit('nodeClick', { id: n.id, node: n.__node })
      // Fly camera to the clicked node
      const distance = 120
      const distRatio = 1 + distance / Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0)
      graph.cameraPosition(
        {
          x: (n.x ?? 0) * distRatio,
          y: (n.y ?? 0) * distRatio,
          z: (n.z ?? 0) * distRatio,
        },
        n,           // lookAt
        800          // ms transition
      )
    })

  // Zoom to fit after the simulation has had a moment to settle
  setTimeout(() => {
    graph?.zoomToFit(400)
  }, 1200)
})

onBeforeUnmount(() => {
  graph?._destructor?.()
  graph = null
})

// ---------------------------------------------------------------------------
// Reactive updates
// ---------------------------------------------------------------------------
watch(
  () => [props.nodes, props.edges] as const,
  () => {
    if (graph) {
      graph.graphData(toGraphData(props.nodes, props.edges))
    }
  }
)
</script>

<style scoped>
.threed-graph {
  width: 100%;
  height: 100%;
}
</style>
