<script setup lang="ts">
import { ref } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import type { Join, ColumnRef } from '../../../types/query-spec'

interface AvailableEntity { name: string; label: string }
interface AssociationSuggestion {
  name: string
  targetEntity: string
  cardinality: 'to-one' | 'to-many'
  onLocal: string[]
  onTarget: string[]
}

const props = defineProps<{
  join: Join
  availableEntities: AvailableEntity[]
  suggestions: AssociationSuggestion[]
  existingAliases: string[]   // aliases already in scope (FROM + previous JOINs)
}>()

const emit = defineEmits<{
  (e: 'change', join: Join): void
  (e: 'remove'): void
}>()

const popoverOpen = ref(false)
const draftKind = ref<'inner' | 'left'>(props.join.kind)
const draftTargetEntity = ref(props.join.target.entity)
const draftTargetAlias = ref(props.join.target.alias)
const draftLeftAlias = ref(props.join.on.leftRef.alias)
const draftLeftCol = ref(props.join.on.leftRef.column)
const draftRightCol = ref(props.join.on.rightRef.column)

function openPopover() {
  draftKind.value = props.join.kind
  draftTargetEntity.value = props.join.target.entity
  draftTargetAlias.value = props.join.target.alias
  draftLeftAlias.value = props.join.on.leftRef.alias
  draftLeftCol.value = props.join.on.leftRef.column
  draftRightCol.value = props.join.on.rightRef.column
  popoverOpen.value = true
}

function closePopover() { popoverOpen.value = false }

function applyChange(next: Join) {
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  const left: ColumnRef = { alias: draftLeftAlias.value, column: draftLeftCol.value }
  const right: ColumnRef = { alias: draftTargetAlias.value, column: draftRightCol.value }
  applyChange({
    id: props.join.id,
    kind: draftKind.value,
    target: { entity: draftTargetEntity.value, alias: draftTargetAlias.value },
    on: { leftRef: left, rightRef: right },
  })
}

function applySuggestion(s: AssociationSuggestion) {
  // First aliased entity in scope owns the FK side. We pick the existing
  // alias whose entity holds onLocal — caller passes existingAliases ordered.
  const localAlias = props.existingAliases[0] || 't'
  applyChange({
    id: props.join.id,
    kind: draftKind.value,
    target: { entity: s.targetEntity, alias: aliasFromName(s.targetEntity) },
    on: {
      leftRef:  { alias: localAlias, column: s.onLocal[0] || 'ID' },
      rightRef: { alias: aliasFromName(s.targetEntity), column: s.onTarget[0] || 'ID' },
    },
  })
}

function aliasFromName(name: string): string {
  return (name[0] || 't').toLowerCase()
}

function removeChip() {
  emit('remove')
}

defineExpose({ applyChange, removeChip })
</script>

<template>
  <span class="join-chip" data-chip-kind="join">
    <button
      type="button"
      class="chip-button"
      @click="openPopover"
      :title="`${join.kind.toUpperCase()} JOIN ${join.target.entity} (${join.target.alias})`"
    >
      <span class="kw">{{ join.kind === 'left' ? 'LEFT JOIN' : 'INNER JOIN' }}</span>
      <span class="entity">{{ join.target.entity }}</span>
      <span class="alias">({{ join.target.alias }})</span>
      <span class="kw">ON</span>
      <span class="ref">{{ join.on.leftRef.alias }}.{{ join.on.leftRef.column }}</span>
      <span class="kw">=</span>
      <span class="ref">{{ join.on.rightRef.alias }}.{{ join.on.rightRef.column }}</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit JOIN"
      @close="closePopover"
    >
      <div class="popover-form">
        <fieldset class="kind-group">
          <legend class="form-label">Type</legend>
          <label><input type="radio" v-model="draftKind" value="inner" /> INNER</label>
          <label><input type="radio" v-model="draftKind" value="left" /> LEFT</label>
        </fieldset>

        <div v-if="suggestions.length > 0" class="suggestions">
          <div class="form-label">Suggested joins</div>
          <ul class="suggestion-list">
            <li v-for="s in suggestions" :key="s.name">
              <button
                type="button"
                class="suggestion-row"
                @click="applySuggestion(s)"
              >
                <span class="entity">{{ s.targetEntity }}</span>
                <span class="hint">ON {{ existingAliases[0] || 't' }}.{{ s.onLocal[0] }} = {{ aliasFromName(s.targetEntity) }}.{{ s.onTarget[0] }}</span>
                <span class="cardinality">[{{ s.cardinality }}]</span>
              </button>
            </li>
          </ul>
        </div>

        <details class="custom-join">
          <summary>Custom join</summary>
          <label>
            <span class="form-label">Target entity</span>
            <select v-model="draftTargetEntity" class="form-select">
              <option v-for="e in availableEntities" :key="e.name" :value="e.name">
                {{ e.label }} ({{ e.name }})
              </option>
            </select>
          </label>
          <label>
            <span class="form-label">Target alias</span>
            <input v-model="draftTargetAlias" type="text" class="form-input" />
          </label>
          <div class="on-clause">
            <span>ON</span>
            <select v-model="draftLeftAlias" class="form-select-inline">
              <option v-for="a in existingAliases" :key="a" :value="a">{{ a }}</option>
            </select>
            <span>.</span>
            <input v-model="draftLeftCol" type="text" class="form-input-inline" placeholder="col" />
            <span>=</span>
            <span class="muted">{{ draftTargetAlias }}.</span>
            <input v-model="draftRightCol" type="text" class="form-input-inline" placeholder="col" />
          </div>
          <ui5-button design="Emphasized" @click="applyFromDraft">Apply custom join</ui5-button>
        </details>

        <div class="actions">
          <ui5-button design="Negative" @click="removeChip">Remove join</ui5-button>
          <ui5-button design="Transparent" @click="closePopover">Cancel</ui5-button>
        </div>
      </div>
    </ui5-popover>
  </span>
</template>

<style scoped>
.join-chip { display: inline-flex; }
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
.entity { font-weight: 600; }
.alias { color: var(--sapNeutralTextColor); }
.ref {
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.75rem;
}
.popover-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  min-width: 22rem;
}
.kind-group { border: none; padding: 0; margin: 0; display: flex; gap: 1rem; }
.form-label {
  display: block;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
  margin-bottom: 0.25rem;
}
.suggestions { border-top: 1px solid var(--sapField_BorderColor); padding-top: 0.5rem; }
.suggestion-list { list-style: none; padding: 0; margin: 0.25rem 0; }
.suggestion-row {
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  padding: 0.4rem;
  cursor: pointer;
  margin-bottom: 0.25rem;
  font: inherit;
}
.suggestion-row:hover { background: var(--sapList_Hover_Background); }
.suggestion-row .hint {
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.7rem;
  color: var(--sapNeutralTextColor);
}
.suggestion-row .cardinality {
  font-size: 0.7rem;
  color: var(--sapInformationColor);
}
.custom-join { border-top: 1px solid var(--sapField_BorderColor); padding-top: 0.5rem; }
.custom-join summary { cursor: pointer; font-weight: 600; font-size: 0.85rem; }
.form-select, .form-input {
  width: 100%;
  padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  font: inherit;
}
.on-clause {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.85rem;
  margin: 0.5rem 0;
}
.form-select-inline, .form-input-inline {
  padding: 0.2rem 0.3rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 3px;
  font: inherit;
  width: 5rem;
}
.muted { color: var(--sapNeutralTextColor); }
.actions {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
}
</style>
