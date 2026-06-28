<script setup lang="ts">
import { computed, ref } from 'vue'
import { useGraphData } from './composables/useGraphData'
import { useFilters } from './composables/useFilters'
import { useTelemetry, dispatchPathDrawn } from './composables/useTelemetry'
import { useSelectedNode } from './composables/useSelectedNode'
import ExploreHeader from './components/ExploreHeader.vue'
import ExploreGraph from './components/ExploreGraph.vue'
import NodeDetailPanel from './components/NodeDetailPanel.vue'
import { fetchPath } from './api/path'
import type { ExploreNode } from './types'

const { payload, hasData, error } = useGraphData()
const { enabledNodeTypes, enabledPredicates, toggleNodeType, togglePredicate } = useFilters()
const { selectedNode, selectNode } = useSelectedNode()
useTelemetry()

// Active path overlay — null when no path is drawn. Stored as the ordered
// list of node IDs the graph already uses (t:<slug> / c:<slug>) so
// ExploreGraph can compare against the graph's edge endpoints directly.
const pathNodeIds = ref<string[] | null>(null)
// Track whether the find-path call is in-flight so the UI can show a hint
// (button state lives in ExploreHeader; we expose this for future use and
// to make the "in-flight" state observable in tests).
const pathError = ref<string | null>(null)

// Apply filters before passing to the graph. Edges keep an edge only when both
// endpoints survive the node-type filter AND the predicate itself is enabled.
const filteredNodes = computed(() => {
  if (!payload.value) return []
  return payload.value.nodes.filter(n => enabledNodeTypes.value.has(n.type))
})
const filteredEdges = computed(() => {
  if (!payload.value) return []
  const visibleNodeIds = new Set(filteredNodes.value.map(n => n.id))
  return payload.value.edges.filter(e =>
    enabledPredicates.value.has(e.p) &&
    visibleNodeIds.has(e.s) &&
    visibleNodeIds.has(e.o),
  )
})

function onNodeClick(e: { id: string; node: ExploreNode }) {
  selectNode(e.node)
}

// Map a tutorial / concept slug to the node-id the graph uses. The slug
// alone is ambiguous (tutorial 'cap-handlers' and concept 'cap-handlers'
// share a slug but have ids 't:cap-handlers' / 'c:cap-handlers'). The
// /graph/path endpoint currently returns tutorial slugs only, but we
// resolve via the loaded graph payload so we transparently support
// future endpoints that return concepts too.
function resolveNodeId(slug: string): string | null {
  if (!payload.value) return null
  // Prefer tutorial match (PATH_BETWEEN walks tutorial nodes), fall back to
  // any node with that slug.
  const tutorial = payload.value.nodes.find(n => n.type === 'tutorial' && n.slug === slug)
  if (tutorial) return tutorial.id
  const any = payload.value.nodes.find(n => n.slug === slug)
  return any?.id ?? null
}

async function onFindPath(p: { from: string; to: string }) {
  pathError.value = null
  try {
    const result = await fetchPath(p.from, p.to)
    if (!result || result.steps.length === 0) {
      pathNodeIds.value = null
      pathError.value = 'No path found between those tutorials.'
      return
    }
    // Build the path-node-id chain. Prepend the source ('from') because
    // the server-side PATH_BETWEEN returns target-side candidates only;
    // the source isn't included in the response steps.
    const ids: string[] = []
    const fromId = resolveNodeId(p.from)
    if (fromId) ids.push(fromId)
    for (const step of result.steps) {
      const id = resolveNodeId(step.slug)
      if (id && id !== ids[ids.length - 1]) ids.push(id)
    }
    if (ids.length < 2) {
      pathNodeIds.value = null
      pathError.value = 'Path returned but none of the steps are loaded in the current graph view.'
      return
    }
    pathNodeIds.value = ids
    dispatchPathDrawn({ from: p.from, to: p.to, stepCount: ids.length })
  } catch (e) {
    console.error('findPath failed', e)
    pathNodeIds.value = null
    pathError.value = 'Path query failed. Please try again.'
  }
}
</script>

<template>
  <main class="explore">
    <p v-if="error" class="explore__error">Failed to load graph: {{ error.message }}</p>
    <p v-else-if="!hasData" class="explore__empty">Loading graph…</p>
    <template v-else>
      <ExploreHeader
        :allNodes="payload!.nodes"
        :enabledNodeTypes="enabledNodeTypes"
        :enabledPredicates="enabledPredicates"
        @toggleNodeType="toggleNodeType"
        @togglePredicate="togglePredicate"
        @findPath="onFindPath"
      />
      <p v-if="pathError" class="explore__path-status" role="status">{{ pathError }}</p>
      <div class="explore__body">
        <div class="explore__canvas">
          <ExploreGraph
            :nodes="filteredNodes"
            :edges="filteredEdges"
            :path="pathNodeIds"
            @nodeClick="onNodeClick"
          />
        </div>
        <NodeDetailPanel
          class="explore__side"
          :selectedNode="selectedNode"
          :edges="payload!.edges"
        />
      </div>
    </template>
  </main>
</template>

<style>
.explore {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.explore__body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}
.explore__canvas {
  flex: 1;
  min-width: 0;
  position: relative;
}
.explore__side {
  width: 20%;
  min-width: 260px;
  max-width: 360px;
  flex-shrink: 0;
}
.explore__error {
  color: #b00;
  padding: 1rem;
}
.explore__empty {
  text-align: center;
  margin-top: 4rem;
  color: #666;
}
.explore__path-status {
  background: #fff7e6;
  color: #6b4500;
  border-bottom: 1px solid #f0d9a8;
  padding: 0.5rem 1rem;
  margin: 0;
  font-size: 0.9rem;
}
</style>
