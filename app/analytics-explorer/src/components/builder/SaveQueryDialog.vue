<script setup lang="ts">
import { ref, watch } from 'vue'
import '@ui5/webcomponents/dist/Dialog.js'
import '@ui5/webcomponents/dist/Button.js'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'save', payload: { name: string; description: string; visibility: 'private' | 'shared-admins' }): void
  (e: 'cancel'): void
}>()

const draftName = ref('')
const draftDescription = ref('')
const draftVisibility = ref<'private' | 'shared-admins'>('private')

// Reset form when dialog opens.
watch(() => props.open, (open) => {
  if (open) {
    draftName.value = ''
    draftDescription.value = ''
    draftVisibility.value = 'private'
  }
})

function onSave() {
  if (!draftName.value.trim()) return  // gate: name required
  emit('save', {
    name: draftName.value.trim(),
    description: draftDescription.value.trim(),
    visibility: draftVisibility.value,
  })
}

function onCancel() {
  emit('cancel')
}

defineExpose({ onSave, onCancel, draftName, draftDescription, draftVisibility })
</script>

<template>
  <ui5-dialog v-if="open" :open="open" header-text="Save query">
    <div class="dialog-body">
      <label>
        <span class="form-label">Name *</span>
        <input v-model="draftName" type="text" class="form-input" required />
      </label>
      <label>
        <span class="form-label">Description</span>
        <textarea v-model="draftDescription" class="form-textarea" rows="2" />
      </label>
      <fieldset class="vis-group">
        <legend class="form-label">Visibility</legend>
        <label><input type="radio" v-model="draftVisibility" value="private" /> Private</label>
        <label><input type="radio" v-model="draftVisibility" value="shared-admins" /> Shared with admins</label>
      </fieldset>
    </div>
    <div slot="footer" class="dialog-footer">
      <ui5-button design="Transparent" @click="onCancel">Cancel</ui5-button>
      <ui5-button design="Emphasized" :disabled="!draftName.trim()" @click="onSave">Save</ui5-button>
    </div>
  </ui5-dialog>
</template>

<style scoped>
.dialog-body { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem; min-width: 24rem; }
.form-label { font-size: 0.78rem; color: var(--sapContent_LabelColor); margin-bottom: 0.2rem; display: block; }
.form-input, .form-textarea {
  width: 100%; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px; font: inherit;
}
.vis-group { border: none; padding: 0; margin: 0; display: flex; gap: 1rem; }
.vis-group legend { width: 100%; }
.dialog-footer { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0.5rem; }
</style>
