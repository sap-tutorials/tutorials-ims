<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import type { OrderClause, SelectItem, ColumnRef } from '../../../types/query-spec'

interface ColumnMeta { type: string }

const props = defineProps<{
  order: OrderClause
  selectItems: SelectItem[]
  aliasMap: Map<string, { columns: Map<string, ColumnMeta> }>
}>()

const emit = defineEmits<{
  (e: 'change', next: OrderClause): void
  (e: 'remove'): void
}>()

const popoverOpen = ref(false)

// Compact-form display
const compact = computed(() => {
  const dir = props.order.direction.toUpperCase()
  if (props.order.by.kind === 'selectId') {
    const target = props.selectItems.find(s => s.id === props.order.by.kind === 'selectId' && (props.order.by as any).id === s.id)
    // Pull target via a clean lookup:
    const id = (props.order.by as { kind: 'selectId'; id: string }).id
    const item = props.selectItems.find(s => s.id === id)
    if (!item) return `<unknown> ${dir}`
    if (item.kind === 'column') return `${item.alias || `${item.ref.alias}.${item.ref.column}`} ${dir}`
    if (item.kind === 'aggregation') return `${item.alias || item.fn.toUpperCase()} ${dir}`
    return `${item.alias} ${dir}`
  }
  const ref = (props.order.by as { kind: 'columnRef'; ref: ColumnRef }).ref
  return `${ref.alias}.${ref.column} ${dir}`
})

// Draft state
const draftKind = ref<'selectId' | 'columnRef'>(props.order.by.kind)
const draftSelectId = ref('')
const draftColAlias = ref('')
const draftColColumn = ref('')
const draftDirection = ref<'asc' | 'desc'>(props.order.direction)

function openPopover() {
  draftKind.value = props.order.by.kind
  if (props.order.by.kind === 'selectId') {
    draftSelectId.value = props.order.by.id
  } else {
    draftColAlias.value = props.order.by.ref.alias
    draftColColumn.value = props.order.by.ref.column
  }
  draftDirection.value = props.order.direction
  popoverOpen.value = true
}

function closePopover() { popoverOpen.value = false }

function applyChange(next: OrderClause) {
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  const by = draftKind.value === 'selectId'
    ? { kind: 'selectId' as const, id: draftSelectId.value }
    : { kind: 'columnRef' as const, ref: { alias: draftColAlias.value, column: draftColColumn.value } }
  applyChange({ id: props.order.id, by, direction: draftDirection.value })
}

function removeChip() { emit('remove') }

const availableAliases = computed(() => Array.from(props.aliasMap.keys()))
function colsForAlias(alias: string): string[] {
  const ent = props.aliasMap.get(alias)
  return ent ? Array.from(ent.columns.keys()) : []
}

function selectItemLabel(s: SelectItem): string {
  if (s.kind === 'column') return s.alias ? `${s.alias} (${s.ref.alias}.${s.ref.column})` : `${s.ref.alias}.${s.ref.column}`
  if (s.kind === 'aggregation') {
    const inner = s.ref === '*' ? '*' : `${s.ref.alias}.${s.ref.column}`
    return s.alias ? `${s.alias} (${s.fn.toUpperCase()}(${inner}))` : `${s.fn.toUpperCase()}(${inner})`
  }
  return s.alias
}

defineExpose({ applyChange, removeChip })
</script>

<template>
  <span class="orderby-chip" data-chip-kind="order-by">
    <button type="button" class="chip-button" @click="openPopover" :title="`ORDER BY ${compact}`">
      <span class="kw">ORDER BY</span>
      <span class="content">{{ compact }}</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit ORDER BY"
      @close="closePopover"
    >
      <div class="popover-form">
        <fieldset class="kind-group">
          <legend class="form-label">Order by</legend>
          <label><input type="radio" v-model="draftKind" value="selectId" /> SELECT item</label>
          <label><input type="radio" v-model="draftKind" value="columnRef" /> Column ref</label>
        </fieldset>

        <div v-if="draftKind === 'selectId'" class="kind-section">
          <label>
            <span class="form-label">SELECT item</span>
            <select v-model="draftSelectId" class="form-select">
              <option v-for="s in selectItems" :key="s.id" :value="s.id">{{ selectItemLabel(s) }}</option>
            </select>
          </label>
        </div>

        <div v-else class="kind-section">
          <label>
            <span class="form-label">Alias</span>
            <select v-model="draftColAlias" class="form-select">
              <option v-for="a in availableAliases" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
          <label>
            <span class="form-label">Column</span>
            <select v-model="draftColColumn" class="form-select">
              <option v-for="c in colsForAlias(draftColAlias)" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>

        <fieldset class="kind-group">
          <legend class="form-label">Direction</legend>
          <label><input type="radio" v-model="draftDirection" value="asc" /> ASC</label>
          <label><input type="radio" v-model="draftDirection" value="desc" /> DESC</label>
        </fieldset>

        <div class="actions">
          <ui5-button design="Negative" @click="removeChip">Remove</ui5-button>
          <ui5-button design="Transparent" @click="closePopover">Cancel</ui5-button>
          <ui5-button design="Emphasized" @click="applyFromDraft">Apply</ui5-button>
        </div>
      </div>
    </ui5-popover>
  </span>
</template>

<style scoped>
.orderby-chip { display: inline-flex; }
.chip-button {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  background: var(--sapList_Background);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.8rem;
}
.chip-button:hover { background: var(--sapList_Hover_Background); }
.kw { font-weight: bold; color: var(--sapNeutralTextColor); font-size: 0.75rem; }
.content { font-family: var(--sapContent_MonospaceFontFamily, monospace); font-size: 0.75rem; }
.popover-form {
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 1rem; min-width: 20rem;
}
.kind-group { border: none; padding: 0; margin: 0; display: flex; gap: 1rem; }
.kind-section { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.25rem; border-top: 1px solid var(--sapField_BorderColor); }
.form-label { font-size: 0.75rem; color: var(--sapContent_LabelColor); }
.form-select {
  width: 100%; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px; font: inherit;
}
.actions {
  display: flex; gap: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
}
.actions ui5-button:first-child { margin-right: auto; }
</style>
