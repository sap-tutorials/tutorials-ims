<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import FilterChip from './FilterChip.vue'
import { isFilterGroup } from '../../../types/query-spec'
import type { FilterGroup, FilterNode, Filter } from '../../../types/query-spec'

const MAX_DEPTH = 4

interface ColumnMeta {
  type: string
  filterMode: 'enum' | 'free' | 'date' | 'numeric-range'
  filterSample?: boolean
}

interface DistinctResult { values: string[]; truncated: boolean }

const props = defineProps<{
  group: FilterGroup
  aliasMap: Map<string, { columns: Map<string, ColumnMeta> }>
  sampleDistinctCached: (table: string, column: string) => Promise<DistinctResult>
  depth: number
}>()

const emit = defineEmits<{
  (e: 'change', g: FilterGroup): void
  (e: 'remove'): void
  (e: 'unwrap'): void
}>()

const popoverOpen = ref(false)

const canAddNestedGroup = computed(() => props.depth < MAX_DEPTH)

const conjLabel = computed(() => props.group.conjunction === 'or' ? 'OR' : 'AND')

function openPopover() { popoverOpen.value = true }
function closePopover() { popoverOpen.value = false }

function toggleConjunction() {
  emit('change', {
    ...props.group,
    conjunction: props.group.conjunction === 'and' ? 'or' : 'and',
  })
}

function toggleNot() {
  emit('change', { ...props.group, negated: !props.group.negated })
}

function removeChild(childId: string) {
  emit('change', {
    ...props.group,
    children: props.group.children.filter(c => c.id !== childId),
  })
}

function replaceChild(childId: string, next: FilterNode) {
  emit('change', {
    ...props.group,
    children: props.group.children.map(c => c.id === childId ? next : c),
  })
}

function removeChip() { emit('remove') }
function unwrapGroup() { emit('unwrap') }

defineExpose({
  toggleConjunction,
  toggleNot,
  removeChild,
  replaceChild,
  removeChip,
  unwrapGroup,
  canAddNestedGroup,
})
</script>

<template>
  <span class="filter-group" data-chip-kind="filter-group">
    <button
      type="button"
      class="bracket-button"
      @click="openPopover"
      :title="`${group.negated ? 'NOT ' : ''}${conjLabel} group (depth ${depth})`"
    >
      <span v-if="group.negated" class="kw">NOT</span>
      <span class="bracket">(</span>
    </button>

    <template v-for="(child, idx) in group.children" :key="child.id">
      <span v-if="idx > 0" class="conjunction">{{ conjLabel }}</span>

      <FilterGroupChip
        v-if="isFilterGroup(child)"
        :group="child"
        :alias-map="aliasMap"
        :sample-distinct-cached="sampleDistinctCached"
        :depth="depth + 1"
        @change="(next: FilterGroup) => replaceChild(child.id, next)"
        @remove="removeChild(child.id)"
        @unwrap="(/* future */) => removeChild(child.id)"
      />

      <FilterChip
        v-else
        :filter="(child as Filter)"
        :alias-map="aliasMap"
        :sample-distinct-cached="sampleDistinctCached"
        @change="(next: Filter) => replaceChild(child.id, next)"
        @remove="removeChild(child.id)"
      />
    </template>

    <span class="bracket">)</span>

    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Filter group"
      @close="closePopover"
    >
      <div class="popover-form">
        <p class="muted">
          Depth {{ depth }} {{ depth >= MAX_DEPTH ? '(max)' : '' }} — {{ group.children.length }} child(ren)
        </p>
        <div class="conj-toggle">
          <span class="form-label">Conjunction</span>
          <ui5-button @click="toggleConjunction">
            Switch to {{ group.conjunction === 'and' ? 'OR' : 'AND' }}
          </ui5-button>
        </div>
        <div class="not-toggle">
          <label>
            <input type="checkbox" :checked="!!group.negated" @change="toggleNot" />
            Wrap in NOT(...)
          </label>
        </div>
        <div class="actions">
          <ui5-button design="Negative" @click="removeChip">Remove group</ui5-button>
          <ui5-button
            v-if="group.children.length === 1"
            design="Transparent"
            @click="unwrapGroup"
          >Ungroup (keep child)</ui5-button>
          <ui5-button design="Transparent" @click="closePopover">Close</ui5-button>
        </div>
      </div>
    </ui5-popover>
  </span>
</template>

<style scoped>
.filter-group {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
}
.bracket-button {
  background: transparent;
  border: 1px solid transparent;
  padding: 0 0.2rem;
  cursor: pointer;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
}
.bracket-button:hover { background: var(--sapList_Hover_Background); border-color: var(--sapField_BorderColor); border-radius: 3px; }
.bracket {
  font-weight: bold;
  font-size: 1rem;
  color: var(--sapNeutralTextColor);
}
.conjunction {
  font-weight: bold;
  color: var(--sapInformationColor);
  font-size: 0.75rem;
  padding: 0 0.2rem;
}
.kw { font-weight: bold; color: var(--sapErrorColor); font-size: 0.75rem; }
.popover-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  min-width: 18rem;
}
.muted { color: var(--sapNeutralTextColor); font-size: 0.75rem; margin: 0; }
.form-label { font-size: 0.75rem; color: var(--sapContent_LabelColor); }
.conj-toggle, .not-toggle { display: flex; align-items: center; gap: 0.5rem; }
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
  flex-wrap: wrap;
}
.actions ui5-button:first-child { margin-right: auto; }
</style>
