<!-- app/channel-atlas/src/App.vue
     Root component for the Channel Atlas SPA. -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAtlasData } from './composables/useAtlasData.js'
import { useOwnerTypeFilter } from './composables/useOwnerTypeFilter.js'
import { buildFocusEdges, buildTopicEdges, sizeChannel, ownerTypeColor } from './graph.js'
import AtlasGraph from './components/AtlasGraph.vue'
import OwnerTypeFilter from './components/OwnerTypeFilter.vue'
import ChannelDetailPanel from './components/ChannelDetailPanel.vue'
import type { AtlasNode, AtlasEdge, OwnerType } from './types.js'

const { payload, hasData, error } = useAtlasData()
const { enabledTypes, toggleType } = useOwnerTypeFilter()
const selectedNode = ref<AtlasNode | null>(null)

// Enrich raw DTOs with computed size + color.
const allNodes = computed<AtlasNode[]>(() => {
  if (!payload.value) return []
  return payload.value.channels.map((ch) => ({
    ...ch,
    size: sizeChannel(ch.subscribers, ch.githubStars),
    color: ownerTypeColor(ch.ownerType),
  }))
})

// Apply ownerType filter.
const filteredNodes = computed<AtlasNode[]>(() =>
  allNodes.value.filter(
    (n) => n.ownerType == null || enabledTypes.value.has(n.ownerType as OwnerType),
  ),
)

// Derive edges from filtered nodes only (phase-1 focus + phase-2 topic).
const filteredEdges = computed<AtlasEdge[]>(() => [
  ...buildFocusEdges(filteredNodes.value),
  ...buildTopicEdges(filteredNodes.value),
])

function onNodeClick(e: { id: string; node: AtlasNode }) {
  selectedNode.value = e.node
}
</script>

<template>
  <main class="atlas-page">
    <p v-if="error" class="atlas-page__error" role="alert">
      Failed to load Channel Atlas: {{ error.message }}
    </p>
    <p v-else-if="!hasData" class="atlas-page__loading">
      Loading Channel Atlas…
    </p>
    <template v-else>
      <!-- Toolbar always visible when data is present — even when filteredNodes is
           empty, so the user can re-enable owner types to escape the empty state. -->
      <div class="atlas-page__toolbar">
        <OwnerTypeFilter
          :enabledTypes="enabledTypes"
          @toggle="toggleType"
        />
      </div>
      <p v-if="filteredNodes.length === 0" class="atlas-page__loading">
        No channels to display. Try enabling more owner types.
      </p>
      <div v-else class="atlas-page__body">
        <div class="atlas-page__canvas">
          <AtlasGraph
            :nodes="filteredNodes"
            :edges="filteredEdges"
            @nodeClick="onNodeClick"
          />
        </div>
        <ChannelDetailPanel
          class="atlas-page__side"
          :selectedNode="selectedNode"
        />
      </div>
    </template>
  </main>
</template>
