<script setup lang="ts">
import { ref } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'
import '@ui5/webcomponents/dist/Select.js'
import '@ui5/webcomponents/dist/Option.js'
import '@ui5/webcomponents/dist/Input.js'
import type { TableRef } from '../../../types/query-spec'

interface AvailableEntity { name: string; label: string }

const props = defineProps<{
  from: TableRef
  availableEntities: AvailableEntity[]
}>()

const emit = defineEmits<{
  (e: 'change', from: TableRef): void
}>()

const popoverOpen = ref(false)
const draftEntity = ref(props.from.entity)
const draftAlias = ref(props.from.alias)
const chipEl = ref<HTMLElement | null>(null)

function openPopover() {
  draftEntity.value = props.from.entity
  draftAlias.value = props.from.alias
  popoverOpen.value = true
}

function closePopover() {
  popoverOpen.value = false
}

// Exposed for unit tests; also called by the popover Apply button.
function applyChange(next: TableRef) {
  if (next.entity === props.from.entity && next.alias === props.from.alias) {
    closePopover()
    return
  }
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  applyChange({ entity: draftEntity.value, alias: draftAlias.value || aliasFromName(draftEntity.value) })
}

function aliasFromName(name: string): string {
  return (name[0] || 't').toLowerCase()
}

defineExpose({ applyChange })
</script>

<template>
  <span class="from-chip" data-chip-kind="from">
    <button
      ref="chipEl"
      type="button"
      class="chip-button"
      @click="openPopover"
      :title="`FROM ${from.entity} (${from.alias})`"
    >
      <span class="kw">FROM</span>
      <span class="entity">{{ from.entity }}</span>
      <span class="alias">({{ from.alias }})</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit FROM"
      @close="closePopover"
    >
      <div class="popover-form">
        <label>
          <span class="form-label">Entity</span>
          <select v-model="draftEntity" class="form-select">
            <option
              v-for="e in availableEntities"
              :key="e.name"
              :value="e.name"
            >{{ e.label }} ({{ e.name }})</option>
          </select>
        </label>
        <label>
          <span class="form-label">Alias</span>
          <input
            v-model="draftAlias"
            class="form-input"
            type="text"
            :placeholder="aliasFromName(draftEntity)"
          />
        </label>
        <p class="warning">
          ⚠ Changing entity may break alias references in joins, filters,
          select, and order-by chips.
        </p>
        <div class="actions">
          <ui5-button design="Transparent" @click="closePopover">Cancel</ui5-button>
          <ui5-button design="Emphasized" @click="applyFromDraft">Apply</ui5-button>
        </div>
      </div>
    </ui5-popover>
  </span>
</template>

<style scoped>
.from-chip { display: inline-flex; }
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
.popover-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  min-width: 18rem;
}
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
.warning {
  font-size: 0.75rem;
  color: var(--sapWarningColor);
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
</style>
