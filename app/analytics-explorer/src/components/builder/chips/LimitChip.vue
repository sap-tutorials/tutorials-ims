<script setup lang="ts">
import { ref } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Popover.js'

const props = defineProps<{
  limit: number | null
}>()

const emit = defineEmits<{
  (e: 'change', next: number | null): void
}>()

const popoverOpen = ref(false)
const draftLimit = ref<number>(props.limit ?? 100)
const draftUseServerCap = ref(props.limit === null)

function openPopover() {
  draftLimit.value = props.limit ?? 100
  draftUseServerCap.value = props.limit === null
  popoverOpen.value = true
}

function closePopover() { popoverOpen.value = false }

function applyChange(next: number | null) {
  emit('change', next)
  closePopover()
}

function applyFromDraft() {
  applyChange(draftUseServerCap.value ? null : draftLimit.value)
}

defineExpose({ applyChange })
</script>

<template>
  <span class="limit-chip" data-chip-kind="limit">
    <button type="button" class="chip-button" @click="openPopover">
      <span class="kw">LIMIT</span>
      <span v-if="limit === null" class="server-cap">(server cap)</span>
      <span v-else class="num">{{ limit }}</span>
    </button>
    <ui5-popover
      v-if="popoverOpen"
      :open="popoverOpen"
      placement="Bottom"
      header-text="Edit LIMIT"
      @close="closePopover"
    >
      <div class="popover-form">
        <label>
          <input type="checkbox" v-model="draftUseServerCap" /> Use server cap (5000)
        </label>
        <label v-if="!draftUseServerCap">
          <span class="form-label">Limit</span>
          <input v-model.number="draftLimit" type="number" min="1" max="5000" class="form-input" />
        </label>
        <div class="actions">
          <ui5-button design="Transparent" @click="closePopover">Cancel</ui5-button>
          <ui5-button design="Emphasized" @click="applyFromDraft">Apply</ui5-button>
        </div>
      </div>
    </ui5-popover>
  </span>
</template>

<style scoped>
.limit-chip { display: inline-flex; }
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
.num { font-weight: 600; }
.server-cap { color: var(--sapNeutralTextColor); font-style: italic; font-size: 0.75rem; }
.popover-form {
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 1rem; min-width: 16rem;
}
.form-label { font-size: 0.75rem; color: var(--sapContent_LabelColor); }
.form-input {
  width: 100%; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px; font: inherit;
}
.actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
}
</style>
