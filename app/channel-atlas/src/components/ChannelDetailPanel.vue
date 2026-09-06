<!-- app/channel-atlas/src/components/ChannelDetailPanel.vue
     Fork of app/explore/src/components/NodeDetailPanel.vue.
     Displays details for the selected channel node. -->
<script setup lang="ts">
import { computed } from 'vue'
import type { AtlasNode } from '../types.js'
import { ownerTypeColor } from '../graph.js'

const props = defineProps<{
  selectedNode: AtlasNode | null
}>()

const panelLabel = computed(() =>
  `channel-detail-${props.selectedNode?.id ?? 'none'}`,
)

function colorFor(node: AtlasNode) {
  return ownerTypeColor(node.ownerType)
}

defineExpose({ panelLabel })
</script>

<template>
  <aside class="channel-panel" :data-panel-id="panelLabel">
    <div v-if="!selectedNode" class="channel-panel__empty">
      Click a node to see channel details.
    </div>
    <template v-else>
      <h2 class="channel-panel__name">
        <span
          class="channel-panel__swatch"
          :style="{ background: colorFor(selectedNode) }"
        />
        {{ selectedNode.name }}
      </h2>
      <p v-if="selectedNode.purpose" class="channel-panel__purpose">
        {{ selectedNode.purpose }}
      </p>
      <p class="channel-panel__type">
        Type: {{ selectedNode.ownerType?.replace(/_/g, ' ') ?? 'Unknown' }}
      </p>
      <p v-if="selectedNode.subscribers != null" class="channel-panel__stats">
        Subscribers: {{ selectedNode.subscribers.toLocaleString() }}
      </p>
      <!-- show GitHub stars only for GitHub-type channels — those without a subscriber count,
           to avoid mixing YouTube-subscriber and GitHub-star metrics -->
      <p v-if="selectedNode.githubStars != null && selectedNode.subscribers == null" class="channel-panel__stats">
        GitHub Stars: {{ selectedNode.githubStars.toLocaleString() }}
      </p>
      <ul v-if="selectedNode.focusAreas.length" class="channel-panel__areas">
        <li v-for="area in selectedNode.focusAreas" :key="area">{{ area }}</li>
      </ul>
      <ul v-if="selectedNode.topicTags.length" class="channel-panel__topics">
        <li v-for="tag in selectedNode.topicTags" :key="tag">{{ tag }}</li>
      </ul>
      <a
        :href="selectedNode.url"
        class="channel-panel__link"
        target="_blank"
        rel="noopener noreferrer"
      >Visit channel ↗</a>
    </template>
  </aside>
</template>
