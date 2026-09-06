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

<style scoped>
/* Consumes site theme vars (hugo/assets/css/sap-theme-vars.css, flipped by
   the html.dark class). Light fallbacks keep the standalone/dev build legible. */
.channel-panel {
  color: var(--sapTextColor, #32363a);
  font-size: 0.875rem;
  line-height: 1.5;
}

.channel-panel__empty {
  color: var(--sapContent_LabelColor, #556b82);
  font-style: italic;
}

.channel-panel__name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
  color: var(--sapTextColor, #32363a);
}

.channel-panel__swatch {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  flex-shrink: 0;
}

.channel-panel__purpose {
  margin: 0 0 0.75rem;
  color: var(--sapTextColor, #32363a);
}

.channel-panel__type,
.channel-panel__stats {
  margin: 0.25rem 0;
  color: var(--sapContent_LabelColor, #556b82);
}

.channel-panel__areas,
.channel-panel__topics {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
  color: var(--sapTextColor, #32363a);
}

.channel-panel__topics {
  border-top: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
  padding-top: 0.5rem;
}

.channel-panel__link {
  display: inline-block;
  margin-top: 0.75rem;
  color: var(--sapLinkColor, #0064d9);
  text-decoration: none;
}

.channel-panel__link:hover {
  text-decoration: underline;
}
</style>
