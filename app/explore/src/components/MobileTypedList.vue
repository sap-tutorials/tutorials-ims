<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ExploreNode, NodeType } from '../types'

const props = defineProps<{ nodes: ExploreNode[] }>()

const SECTION_ORDER: NodeType[] = ['tutorial', 'concept', 'mission', 'product', 'group', 'category', 'tag']
const SECTION_LABELS: Record<NodeType, string> = {
  tutorial: 'Tutorials',
  concept: 'Concepts',
  mission: 'Missions',
  product: 'Products',
  group: 'Groups',
  category: 'Categories',
  tag: 'Tags',
}

const groups = computed(() => {
  const out: Partial<Record<NodeType, ExploreNode[]>> = {}
  for (const n of props.nodes) {
    if (!out[n.type]) out[n.type] = []
    out[n.type]!.push(n)
  }
  for (const t of Object.keys(out) as NodeType[]) {
    out[t]!.sort((a, b) => a.label.localeCompare(b.label))
  }
  return out
})

// Defeat Vue 3.5 SFC template hoisting that breaks under @vue/test-utils
const containerLabel = computed(() => `mobile-typed-list-${props.nodes.length}`)

function urlFor(n: ExploreNode): string | null {
  if (n.type === 'tutorial') return `/tutorials/${n.slug}/`
  if (n.type === 'concept')  return `/concepts/${n.slug}/`
  return null  // missions/products/groups/etc have no public landing page yet
}

function onNavigate(n: ExploreNode) {
  if (typeof window === 'undefined') return
  const url = urlFor(n)
  if (!url) return
  window.dispatchEvent(new CustomEvent('kg.explore.node_navigated', {
    detail: { nodeId: n.id, nodeType: n.type, targetUrl: url }
  }))
}

const expanded = ref<Record<NodeType, boolean>>({
  tutorial: true,  // first section open by default
  concept: false,
  mission: false,
  product: false,
  group: false,
  category: false,
  tag: false,
})

function toggleSection(t: NodeType) {
  expanded.value = { ...expanded.value, [t]: !expanded.value[t] }
}
</script>

<template>
  <div class="mobile-typed-list" :data-list-id="containerLabel">
    <div v-if="nodes.length === 0" class="mobile-typed-list__empty">
      No nodes in the graph.
    </div>
    <template v-else>
      <section v-for="t in SECTION_ORDER" :key="t" v-show="groups[t]?.length">
        <button class="mobile-typed-list__section-header" @click="toggleSection(t)">
          <span>{{ SECTION_LABELS[t] }}</span>
          <span class="mobile-typed-list__count">{{ groups[t]?.length ?? 0 }}</span>
        </button>
        <ul v-show="expanded[t]" class="mobile-typed-list__items">
          <li v-for="n in groups[t]" :key="n.id">
            <a v-if="urlFor(n)" :href="urlFor(n)!" @click="onNavigate(n)">{{ n.label }}</a>
            <span v-else class="mobile-typed-list__no-link">{{ n.label }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.mobile-typed-list { padding: 1rem; }
.mobile-typed-list__empty { color: #666; text-align: center; padding: 2rem; }
.mobile-typed-list__section-header {
  display: flex; justify-content: space-between; align-items: center;
  width: 100%; padding: 0.75rem 1rem; background: #f5f5f5; border: none;
  border-radius: 4px; font-weight: 600; cursor: pointer; margin-top: 0.5rem;
}
.mobile-typed-list__count { color: #666; font-size: 0.9rem; }
.mobile-typed-list__items {
  list-style: none; padding: 0.25rem 0 0.5rem 1rem; margin: 0;
}
.mobile-typed-list__items li { padding: 0.5rem 0; }
.mobile-typed-list__items a { color: #0a6ed1; text-decoration: none; }
.mobile-typed-list__items a:hover { text-decoration: underline; }
.mobile-typed-list__no-link { color: #666; }
</style>
