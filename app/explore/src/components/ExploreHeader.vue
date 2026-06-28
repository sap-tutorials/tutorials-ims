<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { ExploreNode, NodeType, PredicateType } from '../types'
import FilterDropdown from './FilterDropdown.vue'

const props = defineProps<{
  allNodes: ExploreNode[]
  enabledNodeTypes: Set<NodeType>
  enabledPredicates: Set<PredicateType>
}>()

const emit = defineEmits<{
  findPath: [{ from: string; to: string }]
  toggleNodeType: [NodeType]
  togglePredicate: [PredicateType]
}>()

const searchQuery = ref('')
const fromSlug = ref('')
const toSlug = ref('')

// Defeat Vue 3.5 SFC template hoisting (same pattern as ExploreGraph.vue):
// touch every reactive dep in a computed bound to the template root so child
// vnodes (button :disabled, dropdown panel, search input) re-render when these
// change. Without this, static-looking child vnodes get hoisted and don't
// re-render under @vue/test-utils 2.4.10 + happy-dom. No runtime effect — it
// just signals the compiler to keep the vnodes in the render function.
const headerLabel = computed(() =>
  `explore-header-${props.allNodes.length}-${fromSlug.value.length}-${toSlug.value.length}-${searchQuery.value.length}-${props.enabledNodeTypes.size}-${props.enabledPredicates.size}`,
)

// Slug suggestions: navigable destinations only (tutorial + concept have detail
// pages; mission/group/etc. don't have a /<type>/<slug>/ route yet).
const slugSuggestions = computed(() =>
  props.allNodes.filter(n => n.type === 'tutorial' || n.type === 'concept'),
)

function dispatchSearch(query: string) {
  if (typeof window === 'undefined') return
  const q = query.toLowerCase()
  const resultCount = q.length === 0
    ? 0
    : props.allNodes.filter(n =>
        n.label.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q),
      ).length
  window.dispatchEvent(new CustomEvent('kg.explore.search', {
    detail: { query, resultCount },
  }))
}

// 200ms debounce on search input.
let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => dispatchSearch(q), 200)
})
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})

const findDisabled = computed(() => !fromSlug.value || !toSlug.value)

function emitFindPath() {
  if (findDisabled.value) return
  emit('findPath', { from: fromSlug.value, to: toSlug.value })
}

// Manual handlers (instead of v-model) to side-step a Vue 3.5 + happy-dom
// hoisting interaction where vModelText directive nodes don't attach under
// @vue/test-utils 2.4.10. The bound input.value still updates on every keystroke,
// matching v-model's user-facing behaviour.
function onSearchInput(e: Event) {
  searchQuery.value = (e.target as HTMLInputElement).value
}
function onFromInput(e: Event) {
  fromSlug.value = (e.target as HTMLInputElement).value
}
function onToInput(e: Event) {
  toSlug.value = (e.target as HTMLInputElement).value
}
</script>

<template>
  <header class="explore-header" :data-header-id="headerLabel">
    <div class="explore-header__brand">SAP Tutorials · Explore</div>
    <input
      type="search"
      class="explore-header__search"
      placeholder="Search nodes…"
      :value="searchQuery"
      @input="onSearchInput"
    />
    <div class="explore-header__path">
      <label class="explore-header__picker">
        From
        <input
          type="text"
          name="from"
          :value="fromSlug"
          @input="onFromInput"
          list="explore-nodes-from"
          placeholder="slug"
          autocomplete="off"
        />
      </label>
      <span class="explore-header__arrow" aria-hidden="true">→</span>
      <label class="explore-header__picker">
        To
        <input
          type="text"
          name="to"
          :value="toSlug"
          @input="onToInput"
          list="explore-nodes-to"
          placeholder="slug"
          autocomplete="off"
        />
      </label>
      <button
        type="button"
        class="explore-header__find-btn"
        :disabled="findDisabled"
        @click="emitFindPath"
      >
        Find
      </button>
    </div>
    <FilterDropdown
      :enabledNodeTypes="enabledNodeTypes"
      :enabledPredicates="enabledPredicates"
      @toggleNodeType="emit('toggleNodeType', $event)"
      @togglePredicate="emit('togglePredicate', $event)"
    />
    <datalist id="explore-nodes-from">
      <option
        v-for="n in slugSuggestions"
        :key="`from-${n.id}`"
        :value="n.slug"
      >
        {{ n.label }}
      </option>
    </datalist>
    <datalist id="explore-nodes-to">
      <option
        v-for="n in slugSuggestions"
        :key="`to-${n.id}`"
        :value="n.slug"
      >
        {{ n.label }}
      </option>
    </datalist>
  </header>
</template>

<style scoped>
.explore-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  height: 60px;
  background: #fff;
  border-bottom: 1px solid #ddd;
  box-sizing: border-box;
  flex-shrink: 0;
}
.explore-header__brand {
  font-weight: 600;
  color: var(--sap-horizon-text, #32363a);
  white-space: nowrap;
}
.explore-header__search {
  flex: 1 1 240px;
  max-width: 360px;
  padding: 0.4rem 0.6rem;
  border: 1px solid #c0c0c0;
  border-radius: 4px;
  font: inherit;
}
.explore-header__path {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.explore-header__picker {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.85rem;
  color: #555;
}
.explore-header__picker input {
  padding: 0.35rem 0.5rem;
  border: 1px solid #c0c0c0;
  border-radius: 4px;
  font: inherit;
  width: 120px;
}
.explore-header__arrow {
  color: #888;
  font-size: 1rem;
}
.explore-header__find-btn {
  padding: 0.4rem 0.9rem;
  border: 1px solid #0a6ed1;
  background: #0a6ed1;
  color: #fff;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.explore-header__find-btn:hover:not(:disabled) {
  background: #085caf;
  border-color: #085caf;
}
.explore-header__find-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
