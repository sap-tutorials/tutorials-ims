<script setup lang="ts">
import { computed } from 'vue'
import { useGraphData } from './composables/useGraphData'
import { useFilters } from './composables/useFilters'
import { useTelemetry } from './composables/useTelemetry'
import { useSelectedNode } from './composables/useSelectedNode'
import ExploreHeader from './components/ExploreHeader.vue'
import ExploreGraph from './components/ExploreGraph.vue'
import NodeDetailPanel from './components/NodeDetailPanel.vue'
import type { ExploreNode } from './types'

const { payload, hasData, error } = useGraphData()
const { enabledNodeTypes, enabledPredicates, toggleNodeType, togglePredicate } = useFilters()
const { selectedNode, selectNode } = useSelectedNode()
useTelemetry()

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

function onFindPath(_payload: { from: string; to: string }) {
  // Wired in Task 5 — emits kg.explore.path_drawn after computing the path.
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
      <div class="explore__body">
        <div class="explore__canvas">
          <ExploreGraph
            :nodes="filteredNodes"
            :edges="filteredEdges"
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
</style>
