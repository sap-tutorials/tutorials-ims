<script setup lang="ts">
import { computed } from 'vue'
import type { ExploreNode, ExploreEdge } from '../types'

const props = defineProps<{
  selectedNode: ExploreNode | null
  edges: ExploreEdge[]
}>()

// Defeat Vue 3.5 SFC template hoisting under @vue/test-utils 2.4.10 + happy-dom.
// Touching all reactive deps from the root attr keeps child vnodes (v-if, v-for)
// from being statically hoisted away from their reactive dependencies.
const panelLabel = computed(() =>
  `node-detail-${props.selectedNode?.id ?? 'none'}-${props.edges.length}`,
)

const detailUrl = computed<string | null>(() => {
  if (!props.selectedNode) return null
  const { type, slug } = props.selectedNode
  if (type === 'tutorial') return `/tutorials/${slug}/`
  if (type === 'concept')  return `/concepts/${slug}/`
  return null
})

const incidentEdges = computed<Record<string, ExploreEdge[]>>(() => {
  if (!props.selectedNode) return {}
  const id = props.selectedNode.id
  const byPredicate: Record<string, ExploreEdge[]> = {}
  for (const e of props.edges) {
    if (e.s !== id && e.o !== id) continue
    if (!byPredicate[e.p]) byPredicate[e.p] = []
    byPredicate[e.p].push(e)
  }
  return byPredicate
})

function onNavigate(_e: Event) {
  if (typeof window === 'undefined' || !props.selectedNode) return
  window.dispatchEvent(new CustomEvent('kg.explore.node_navigated', {
    detail: {
      nodeId: props.selectedNode.id,
      nodeType: props.selectedNode.type,
      targetUrl: detailUrl.value,
    },
  }))
}

defineExpose({ incidentEdges, detailUrl, onNavigate })
</script>

<template>
  <aside class="node-detail" :data-panel-id="panelLabel">
    <div v-if="!selectedNode" class="node-detail__empty">
      Select a node in the graph to see its details.
    </div>
    <div v-else>
      <h2 class="node-detail__name">{{ selectedNode.label }}</h2>
      <p class="node-detail__type">{{ selectedNode.type }}</p>
      <p v-if="detailUrl" class="node-detail__link-wrap">
        <a :href="detailUrl" @click="onNavigate">
          Open {{ selectedNode.type }} page →
        </a>
      </p>
      <div
        v-for="(group, predicate) in incidentEdges"
        :key="predicate"
        class="node-detail__group"
      >
        <h3>{{ predicate }} ({{ group.length }})</h3>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.node-detail {
  padding: 1rem;
  border-left: 1px solid #ddd;
  overflow-y: auto;
  background: #fff;
  height: 100%;
  box-sizing: border-box;
}
.node-detail__empty {
  color: #888;
  font-style: italic;
}
.node-detail__name {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
  color: var(--sap-horizon-text, #32363a);
}
.node-detail__type {
  margin: 0 0 1rem;
  color: #666;
  text-transform: capitalize;
  font-size: 0.85rem;
}
.node-detail__link-wrap {
  margin: 0 0 1rem;
}
.node-detail__link-wrap a {
  color: #0a6ed1;
  text-decoration: none;
}
.node-detail__link-wrap a:hover {
  text-decoration: underline;
}
.node-detail__group {
  margin-top: 0.75rem;
}
.node-detail__group h3 {
  font-size: 0.85rem;
  margin: 0 0 0.25rem;
  color: #444;
  text-transform: capitalize;
}
</style>
