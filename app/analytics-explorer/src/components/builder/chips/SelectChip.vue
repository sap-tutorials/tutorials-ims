<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import { validateExpression } from '../../../lib/expr-validator'
import type { SelectItem, AggFn, ColumnRef } from '../../../types/query-spec'

interface ColumnMeta { type: string }
const NUMERIC_TYPES = new Set(['cds.Integer', 'cds.Decimal', 'cds.Double', 'cds.Int64'])

const props = defineProps<{
  item: SelectItem
  aliasMap: Map<string, { columns: Map<string, ColumnMeta> }>
}>()

const emit = defineEmits<{
  (e: 'change', next: SelectItem): void
  (e: 'remove'): void
}>()

const popoverOpen = ref(false)

const compact = computed(() => {
  if (props.item.kind === 'column') {
    return props.item.alias
      ? `${props.item.ref.alias}.${props.item.ref.column} AS ${props.item.alias}`
      : `${props.item.ref.alias}.${props.item.ref.column}`
  }
  if (props.item.kind === 'aggregation') {
    const fn = props.item.fn.toUpperCase()
    const inner = props.item.ref === '*' ? '*' : `${props.item.ref.alias}.${props.item.ref.column}`
    const distinct = props.item.distinct ? 'DISTINCT ' : ''
    const expr = `${fn}(${distinct}${inner})`
    return props.item.alias ? `${expr} AS ${props.item.alias}` : expr
  }
  // expression
  return `${props.item.sql} AS ${props.item.alias}`
})

const isExpr = computed(() => props.item.kind === 'expression')

// Draft state
const draftKind = ref<'column' | 'aggregation' | 'expression'>(props.item.kind)
const draftAlias = ref('')
const draftColAlias = ref('')
const draftColColumn = ref('')
const draftFn = ref<AggFn>('count')
const draftAggRef = ref<'*' | { alias: string; column: string }>('*')
const draftAggAlias = ref('')
const draftDistinct = ref(false)
const draftExprSql = ref('')
const draftExprAlias = ref('')
const exprValidation = ref<{ ok: boolean; error?: string }>({ ok: true })

function openPopover() {
  draftKind.value = props.item.kind
  if (props.item.kind === 'column') {
    draftColAlias.value = props.item.ref.alias
    draftColColumn.value = props.item.ref.column
    draftAlias.value = props.item.alias || ''
  } else if (props.item.kind === 'aggregation') {
    draftFn.value = props.item.fn
    draftAggRef.value = props.item.ref === '*'
      ? '*'
      : { alias: props.item.ref.alias, column: props.item.ref.column }
    draftAggAlias.value = props.item.alias || ''
    draftDistinct.value = !!props.item.distinct
  } else {
    draftExprSql.value = props.item.sql
    draftExprAlias.value = props.item.alias
    exprValidation.value = validateExpression(props.item.sql)
  }
  popoverOpen.value = true
}

function closePopover() { popoverOpen.value = false }

function applyChange(next: SelectItem) {
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  if (draftKind.value === 'column') {
    applyChange({
      kind: 'column',
      id: props.item.id,
      ref: { alias: draftColAlias.value, column: draftColColumn.value },
      alias: draftAlias.value || undefined,
    })
  } else if (draftKind.value === 'aggregation') {
    applyChange({
      kind: 'aggregation',
      id: props.item.id,
      fn: draftFn.value,
      ref: draftAggRef.value === '*'
        ? '*'
        : { alias: (draftAggRef.value as ColumnRef).alias, column: (draftAggRef.value as ColumnRef).column },
      distinct: draftDistinct.value || undefined,
      alias: draftAggAlias.value || undefined,
    })
  } else {
    const v = validateExpression(draftExprSql.value)
    if (!v.ok) { exprValidation.value = v; return }
    applyChange({
      kind: 'expression',
      id: props.item.id,
      sql: draftExprSql.value,
      alias: draftExprAlias.value || 'expr',
      referencedAliases: v.referencedAliases,
    })
  }
}

function removeChip() { emit('remove') }

function onExprInput() {
  exprValidation.value = validateExpression(draftExprSql.value)
}

const availableAliases = computed(() => Array.from(props.aliasMap.keys()))
function colsForAlias(alias: string): { name: string; numeric: boolean }[] {
  const ent = props.aliasMap.get(alias)
  if (!ent) return []
  return Array.from(ent.columns.entries()).map(([name, meta]) => ({
    name, numeric: NUMERIC_TYPES.has((meta as ColumnMeta).type),
  }))
}
function numericColsForAlias(alias: string): string[] {
  return colsForAlias(alias).filter(c => c.numeric).map(c => c.name)
}

defineExpose({ applyChange, removeChip })
</script>

<template>
  <span class="select-chip" :class="['kind-' + item.kind]" data-chip-kind="select">
    <button
      type="button"
      class="chip-button"
      @click="openPopover"
      :title="`SELECT ${compact}`"
    >
      <span v-if="isExpr" class="fn-marker">ƒ</span>
      <span class="content">{{ compact }}</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit SELECT"
      @close="closePopover"
    >
      <div class="popover-form">
        <fieldset class="kind-group">
          <legend class="form-label">Kind</legend>
          <label><input type="radio" v-model="draftKind" value="column" /> Column</label>
          <label><input type="radio" v-model="draftKind" value="aggregation" /> Aggregation</label>
          <label><input type="radio" v-model="draftKind" value="expression" /> Expression</label>
        </fieldset>

        <!-- COLUMN -->
        <div v-if="draftKind === 'column'" class="kind-section">
          <label>
            <span class="form-label">Alias</span>
            <select v-model="draftColAlias" class="form-select">
              <option v-for="a in availableAliases" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
          <label>
            <span class="form-label">Column</span>
            <select v-model="draftColColumn" class="form-select">
              <option v-for="c in colsForAlias(draftColAlias)" :key="c.name" :value="c.name">{{ c.name }}</option>
            </select>
          </label>
          <label>
            <span class="form-label">Output alias (optional)</span>
            <input v-model="draftAlias" type="text" class="form-input" />
          </label>
        </div>

        <!-- AGGREGATION -->
        <div v-else-if="draftKind === 'aggregation'" class="kind-section">
          <label>
            <span class="form-label">Function</span>
            <select v-model="draftFn" class="form-select">
              <option value="count">COUNT</option>
              <option value="sum">SUM</option>
              <option value="avg">AVG</option>
              <option value="min">MIN</option>
              <option value="max">MAX</option>
            </select>
          </label>
          <label>
            <span class="form-label">Column</span>
            <select
              :value="draftAggRef === '*' ? '*' : (draftAggRef as any).column"
              class="form-select"
              @change="(ev: any) => {
                const v = ev.target.value
                if (v === '*') { draftAggRef = '*' }
                else { draftAggRef = { alias: availableAliases[0] || 't', column: v } }
              }"
            >
              <option value="*">*</option>
              <optgroup
                v-for="a in availableAliases"
                :key="a"
                :label="a"
              >
                <option
                  v-for="c in (draftFn === 'count' ? colsForAlias(a).map(x => x.name) : numericColsForAlias(a))"
                  :key="`${a}.${c}`"
                  :value="c"
                >{{ a }}.{{ c }}</option>
              </optgroup>
            </select>
          </label>
          <label>
            <input type="checkbox" v-model="draftDistinct" /> DISTINCT
          </label>
          <label>
            <span class="form-label">Output alias</span>
            <input v-model="draftAggAlias" type="text" class="form-input" :placeholder="`${draftFn}_${draftAggRef === '*' ? 'all' : (draftAggRef as any).column}`" />
          </label>
        </div>

        <!-- EXPRESSION -->
        <div v-else class="kind-section">
          <label>
            <span class="form-label">SQL fragment</span>
            <textarea
              v-model="draftExprSql"
              class="form-textarea"
              rows="3"
              @input="onExprInput"
              placeholder="e.g. YEAR(t.createdAt)"
            ></textarea>
            <p v-if="!exprValidation.ok" class="error">⚠ {{ exprValidation.error }}</p>
          </label>
          <label>
            <span class="form-label">Alias (required)</span>
            <input v-model="draftExprAlias" type="text" class="form-input" />
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
.select-chip { display: inline-flex; }
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
.kind-aggregation .content { font-family: var(--sapContent_MonospaceFontFamily, monospace); font-weight: 600; }
.kind-expression  .content { font-family: var(--sapContent_MonospaceFontFamily, monospace); }
.fn-marker {
  font-style: italic; font-weight: bold;
  color: var(--sapInformationColor);
  margin-right: 0.2rem;
}
.popover-form {
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 1rem; min-width: 22rem;
}
.kind-group { border: none; padding: 0; margin: 0; display: flex; gap: 1rem; flex-wrap: wrap; }
.kind-section { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.25rem; border-top: 1px solid var(--sapField_BorderColor); }
.form-label { font-size: 0.75rem; color: var(--sapContent_LabelColor); }
.form-select, .form-input, .form-textarea {
  width: 100%; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px; font: inherit;
}
.form-textarea { font-family: var(--sapContent_MonospaceFontFamily, monospace); resize: vertical; }
.error { color: var(--sapErrorColor); font-size: 0.75rem; margin: 0.25rem 0 0; }
.actions {
  display: flex; gap: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
}
.actions ui5-button:first-child { margin-right: auto; }
</style>
