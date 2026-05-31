<script setup lang="ts">
import { ref } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import type { GroupKey, ColumnRef } from '../../../types/query-spec'

interface ChipKey extends GroupKey {
  auto: boolean   // true when this chip was derived from a non-aggregation SELECT chip
}

interface ColumnMeta { type: string }

const props = defineProps<{
  chipKey: ChipKey
  aliasMap: Map<string, { columns: Map<string, ColumnMeta> }>
}>()

const emit = defineEmits<{
  (e: 'change', next: ChipKey): void
  (e: 'remove'): void
}>()

const popoverOpen = ref(false)
const draftAlias = ref(props.chipKey.ref.alias)
const draftColumn = ref(props.chipKey.ref.column)

function openPopover() {
  if (props.chipKey.auto) return  // read-only — change the SELECT chip instead
  draftAlias.value = props.chipKey.ref.alias
  draftColumn.value = props.chipKey.ref.column
  popoverOpen.value = true
}

function closePopover() { popoverOpen.value = false }

function applyChange(next: ChipKey) {
  if (props.chipKey.auto) return
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  applyChange({
    ...props.chipKey,
    ref: { alias: draftAlias.value, column: draftColumn.value },
  })
}

function removeChip() {
  if (props.chipKey.auto) return
  emit('remove')
}

defineExpose({ applyChange, removeChip })

// Available aliases derived from the alias map for the dropdown.
const availableAliases = Array.from(props.aliasMap.keys())
function colsForAlias(alias: string): string[] {
  const ent = props.aliasMap.get(alias)
  return ent ? Array.from(ent.columns.keys()) : []
}
</script>

<template>
  <span class="groupby-chip" :class="{ auto: chipKey.auto }" data-chip-kind="group-by">
    <button
      type="button"
      class="chip-button"
      :disabled="chipKey.auto"
      @click="openPopover"
      :title="chipKey.auto ? 'Auto-derived from SELECT chip — edit there' : `GROUP BY ${chipKey.ref.alias}.${chipKey.ref.column}`"
    >
      <span class="kw">GROUP BY</span>
      <span class="ref">{{ chipKey.ref.alias }}.{{ chipKey.ref.column }}</span>
      <span v-if="chipKey.auto" class="auto-marker">(auto)</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit GROUP BY"
      @close="closePopover"
    >
      <div class="popover-form">
        <label>
          <span class="form-label">Alias</span>
          <select v-model="draftAlias" class="form-select">
            <option v-for="a in availableAliases" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
        <label>
          <span class="form-label">Column</span>
          <select v-model="draftColumn" class="form-select">
            <option v-for="c in colsForAlias(draftAlias)" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
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
.groupby-chip { display: inline-flex; }
.groupby-chip.auto .chip-button {
  background: var(--sapList_HeaderBackground);
  cursor: default;
}
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
.chip-button:not(:disabled):hover { background: var(--sapList_Hover_Background); }
.chip-button:disabled { opacity: 0.7; }
.kw { font-weight: bold; color: var(--sapNeutralTextColor); font-size: 0.75rem; }
.ref { font-family: var(--sapContent_MonospaceFontFamily, monospace); font-size: 0.75rem; }
.auto-marker { font-size: 0.7rem; color: var(--sapNeutralTextColor); font-style: italic; }
.popover-form {
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 1rem; min-width: 16rem;
}
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
