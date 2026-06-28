<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted, getCurrentInstance } from 'vue'
import type { NodeType, PredicateType } from '../types'
import { ALL_NODE_TYPES, ALL_PREDICATES } from '../composables/useFilters'

const props = defineProps<{
  enabledNodeTypes: Set<NodeType>
  enabledPredicates: Set<PredicateType>
}>()

const emit = defineEmits<{
  toggleNodeType: [NodeType]
  togglePredicate: [PredicateType]
}>()

const open = ref(false)
// Vue 3.5's SFC compiler hoists static root vnodes and template refs on
// hoisted vnodes silently stay null ("Missing ref owner context" warn).
// Workaround: read $el on mount via the component instance.
const rootEl = ref<HTMLElement | null>(null)
const instance = getCurrentInstance()
onMounted(() => {
  rootEl.value = (instance?.proxy?.$el as HTMLElement) ?? null
})

function toggle() {
  open.value = !open.value
}

function onDocMousedown(e: MouseEvent) {
  if (!open.value || !rootEl.value) return
  if (rootEl.value.contains(e.target as Node)) return
  open.value = false
}

watch(open, (isOpen) => {
  if (typeof document === 'undefined') return
  if (isOpen) {
    document.addEventListener('mousedown', onDocMousedown)
  } else {
    document.removeEventListener('mousedown', onDocMousedown)
  }
}, { flush: 'sync' })

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('mousedown', onDocMousedown)
})

const enabledCount = computed(
  () => props.enabledNodeTypes.size + props.enabledPredicates.size,
)
const totalCount = ALL_NODE_TYPES.length + ALL_PREDICATES.length

function onNodeTypeChange(t: NodeType) {
  emit('toggleNodeType', t)
}
function onPredicateChange(p: PredicateType) {
  emit('togglePredicate', p)
}
</script>

<template>
  <div class="filter-dropdown">
    <button
      class="filter-dropdown__toggle"
      type="button"
      :aria-expanded="open"
      @click="toggle"
    >
      Filters ({{ enabledCount }}/{{ totalCount }})
    </button>
    <div v-if="open" class="filter-dropdown__panel" role="dialog" aria-label="Filters">
      <section class="filter-dropdown__section">
        <h4>Node types</h4>
        <label
          v-for="t in ALL_NODE_TYPES"
          :key="t"
          class="filter-dropdown__row"
        >
          <input
            type="checkbox"
            :checked="enabledNodeTypes.has(t)"
            @change="onNodeTypeChange(t)"
          />
          <span>{{ t }}</span>
        </label>
      </section>
      <section class="filter-dropdown__section">
        <h4>Predicates</h4>
        <label
          v-for="p in ALL_PREDICATES"
          :key="p"
          class="filter-dropdown__row"
        >
          <input
            type="checkbox"
            :checked="enabledPredicates.has(p)"
            @change="onPredicateChange(p)"
          />
          <span>{{ p }}</span>
        </label>
      </section>
    </div>
  </div>
</template>

<style scoped>
.filter-dropdown {
  position: relative;
}
.filter-dropdown__toggle {
  background: #fff;
  border: 1px solid #c0c0c0;
  border-radius: 4px;
  padding: 0.4rem 0.75rem;
  font: inherit;
  cursor: pointer;
  color: var(--sap-horizon-text, #32363a);
}
.filter-dropdown__toggle:hover {
  background: #f5f5f5;
}
.filter-dropdown__panel {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  background: #fff;
  border: 1px solid #c0c0c0;
  border-radius: 4px;
  padding: 0.75rem 1rem;
  z-index: 10;
  min-width: 220px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.filter-dropdown__section + .filter-dropdown__section {
  margin-top: 0.75rem;
  border-top: 1px solid #eee;
  padding-top: 0.75rem;
}
.filter-dropdown__section h4 {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #666;
}
.filter-dropdown__row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0;
  font-size: 0.9rem;
  cursor: pointer;
  text-transform: capitalize;
}
.filter-dropdown__row input {
  margin: 0;
}
</style>
