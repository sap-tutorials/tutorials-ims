<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import type { Filter, FilterOp, FilterValue } from '../../../types/query-spec'

interface ColumnMeta {
  type: string
  filterMode: 'enum' | 'free' | 'date' | 'numeric-range'
  filterSample?: boolean
}

interface DistinctResult { values: string[]; truncated: boolean }

const props = defineProps<{
  filter: Filter
  aliasMap: Map<string, { columns: Map<string, ColumnMeta> }>
  sampleDistinctCached: (table: string, column: string) => Promise<DistinctResult>
}>()

const emit = defineEmits<{
  (e: 'change', f: Filter): void
  (e: 'remove'): void
}>()

const popoverOpen = ref(false)

// Resolve the column's filterMode from the alias map. Default to 'free' if
// lookup fails (matches server-side default for unannotated columns).
const colMeta = computed<ColumnMeta>(() => {
  const ent = props.aliasMap.get(props.filter.ref.alias)
  return ent?.columns.get(props.filter.ref.column) ?? { type: 'cds.String', filterMode: 'free' }
})

// Per-mode allowed operators (mirrors srv/lib/query-spec-validator.mjs OP_TYPE_OK
// + the spec's plan-table for FilterChip):
const OPS_BY_MODE: Record<string, FilterOp[]> = {
  enum: ['eq', 'neq', 'in', 'isNull'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'sinceDays', 'inLastDays', 'inCurrent', 'isNull'],
  'numeric-range': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull'],
  // 'in' deliberately excluded for free-text — paste-the-spreadsheet attack vector.
  free: ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'isNull'],
}

const availableOps = computed<FilterOp[]>(() => OPS_BY_MODE[colMeta.value.filterMode] || OPS_BY_MODE.free)

// Compact display
const compactValue = computed(() => {
  const v = props.filter.value
  if (props.filter.op === 'isNull') return ''
  switch (v.kind) {
    case 'literal': return String(v.value)
    case 'list': return `(${(v.value as any[]).join(', ')})`
    case 'range': return `${v.value[0]} AND ${v.value[1]}`
    case 'relative': return `${v.value} ${v.unit || 'days'}`
    case 'period': return v.value
    default: return ''
  }
})

const opLabel = computed(() => {
  const labels: Record<FilterOp, string> = {
    eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
    in: 'IN', contains: 'LIKE', startsWith: 'STARTS WITH', endsWith: 'ENDS WITH',
    between: 'BETWEEN', isNull: 'IS NULL',
    sinceDays: 'since (days)', inLastDays: 'in last (days)', inCurrent: 'in current',
  }
  return labels[props.filter.op] || props.filter.op
})

// Draft state for the popover
const draftOp = ref<FilterOp>(props.filter.op)
const draftLiteral = ref('')
const draftListText = ref('')
const draftFromVal = ref('')
const draftToVal = ref('')
const draftRelativeNum = ref(30)
const draftPeriod = ref<'day' | 'week' | 'month' | 'quarter' | 'year'>('month')
const distinctValues = ref<string[]>([])
const distinctLoading = ref(false)
const distinctTruncated = ref(false)
const draftSelectedDistinct = ref<string[]>([])

function openPopover() {
  draftOp.value = props.filter.op
  // Populate drafts from the current value.
  const v = props.filter.value
  if (v.kind === 'literal') draftLiteral.value = String(v.value ?? '')
  if (v.kind === 'list') {
    draftSelectedDistinct.value = [...(v.value as any[])].map(String)
    draftListText.value = (v.value as any[]).join(',')
  }
  if (v.kind === 'range') {
    draftFromVal.value = String(v.value[0])
    draftToVal.value = String(v.value[1])
  }
  if (v.kind === 'relative') draftRelativeNum.value = Number(v.value) || 0
  if (v.kind === 'period') draftPeriod.value = (v.value as any)
  popoverOpen.value = true

  // Lazy-load distinct values for enum-mode columns with sample=true.
  if (colMeta.value.filterMode === 'enum' && colMeta.value.filterSample && distinctValues.value.length === 0) {
    distinctLoading.value = true
    props.sampleDistinctCached(props.filter.ref.alias, props.filter.ref.column)
      .then(r => {
        distinctValues.value = r.values
        distinctTruncated.value = r.truncated
      })
      .catch(() => { /* swallow — user can type custom value */ })
      .finally(() => { distinctLoading.value = false })
  }
}

function closePopover() { popoverOpen.value = false }

function buildValueFromDraft(): FilterValue {
  switch (draftOp.value) {
    case 'in':
      return {
        kind: 'list',
        value: draftSelectedDistinct.value.length > 0
          ? draftSelectedDistinct.value
          : draftListText.value.split(',').map(s => s.trim()).filter(Boolean),
      }
    case 'between':
      return { kind: 'range', value: [draftFromVal.value, draftToVal.value] }
    case 'sinceDays':
    case 'inLastDays':
      return { kind: 'relative', value: draftRelativeNum.value, unit: 'days' }
    case 'inCurrent':
      return { kind: 'period', value: draftPeriod.value }
    case 'isNull':
      return { kind: 'literal', value: null }
    default:
      // eq, neq, gt, gte, lt, lte, contains, startsWith, endsWith
      return { kind: 'literal', value: draftLiteral.value }
  }
}

function applyChange(next: Filter) {
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  applyChange({
    ...props.filter,
    op: draftOp.value,
    value: buildValueFromDraft(),
  })
}

function removeChip() {
  emit('remove')
}

function toggleDistinct(v: string) {
  const i = draftSelectedDistinct.value.indexOf(v)
  if (i >= 0) draftSelectedDistinct.value.splice(i, 1)
  else draftSelectedDistinct.value.push(v)
}

defineExpose({ applyChange, removeChip, availableOps })
</script>

<template>
  <span class="filter-chip" data-chip-kind="filter">
    <button
      type="button"
      class="chip-button"
      @click="openPopover"
      :title="`Filter on ${filter.ref.alias}.${filter.ref.column}`"
    >
      <span class="ref">{{ filter.ref.alias }}.{{ filter.ref.column }}</span>
      <span class="op">{{ opLabel }}</span>
      <span v-if="compactValue" class="val">{{ compactValue }}</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit filter"
      @close="closePopover"
    >
      <div class="popover-form">
        <div class="ref-display">
          <strong>{{ filter.ref.alias }}.{{ filter.ref.column }}</strong>
          <span class="muted">({{ colMeta.filterMode }})</span>
        </div>
        <label>
          <span class="form-label">Operator</span>
          <select v-model="draftOp" class="form-select">
            <option v-for="op in availableOps" :key="op" :value="op">{{ op }}</option>
          </select>
        </label>

        <!-- Value editor varies by op -->
        <div v-if="draftOp === 'isNull'" class="muted">No value needed.</div>

        <div v-else-if="draftOp === 'in'" class="value-editor">
          <span class="form-label">Values</span>
          <div v-if="distinctLoading" class="muted">Loading distinct values…</div>
          <div v-else-if="distinctValues.length > 0" class="distinct-list">
            <label v-for="v in distinctValues" :key="v" class="distinct-row">
              <input
                type="checkbox"
                :checked="draftSelectedDistinct.includes(v)"
                @change="toggleDistinct(v)"
              />
              {{ v }}
            </label>
            <p v-if="distinctTruncated" class="hint">
              Showing first {{ distinctValues.length }} distinct values — type a custom value below.
            </p>
          </div>
          <input
            v-model="draftListText"
            class="form-input"
            type="text"
            placeholder="comma-separated values"
          />
        </div>

        <div v-else-if="draftOp === 'between'" class="value-editor">
          <label>
            <span class="form-label">From</span>
            <input v-model="draftFromVal" class="form-input" :type="colMeta.filterMode === 'date' ? 'date' : 'text'" />
          </label>
          <label>
            <span class="form-label">To</span>
            <input v-model="draftToVal" class="form-input" :type="colMeta.filterMode === 'date' ? 'date' : 'text'" />
          </label>
        </div>

        <div v-else-if="draftOp === 'sinceDays' || draftOp === 'inLastDays'" class="value-editor">
          <label>
            <span class="form-label">Days</span>
            <input v-model.number="draftRelativeNum" class="form-input" type="number" min="1" />
          </label>
        </div>

        <div v-else-if="draftOp === 'inCurrent'" class="value-editor">
          <label>
            <span class="form-label">Period</span>
            <select v-model="draftPeriod" class="form-select">
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </select>
          </label>
        </div>

        <div v-else class="value-editor">
          <label>
            <span class="form-label">Value</span>
            <input
              v-model="draftLiteral"
              class="form-input"
              :type="colMeta.filterMode === 'date' ? 'date' : 'text'"
            />
          </label>
        </div>

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
.filter-chip { display: inline-flex; }
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
.ref {
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.75rem;
}
.op { font-weight: bold; color: var(--sapNeutralTextColor); font-size: 0.75rem; }
.val {
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.75rem;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popover-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  min-width: 22rem;
}
.ref-display { font-size: 0.875rem; }
.muted { color: var(--sapNeutralTextColor); font-size: 0.85rem; }
.form-label {
  display: block;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
  margin-bottom: 0.25rem;
}
.form-select, .form-input {
  width: 100%;
  padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  font: inherit;
}
.value-editor { display: flex; flex-direction: column; gap: 0.5rem; }
.distinct-list {
  max-height: 12rem;
  overflow-y: auto;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  padding: 0.25rem;
  margin-bottom: 0.25rem;
}
.distinct-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0.4rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.distinct-row:hover { background: var(--sapList_Hover_Background); }
.hint {
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor);
  margin: 0.25rem 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
}
.actions ui5-button:first-child { margin-right: auto; }
</style>
