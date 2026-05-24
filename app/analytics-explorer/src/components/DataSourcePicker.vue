<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getCachedEntityMetadata, type ExposedEntity } from '../api/entities'
import '@ui5/webcomponents/dist/Select.js'
import '@ui5/webcomponents/dist/Option.js'

const props = defineProps<{ modelValue: string | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
const entities = ref<ExposedEntity[]>([])
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    entities.value = await getCachedEntityMetadata()
    // ui5-select always renders the first <ui5-option> as visible-selected,
    // even when modelValue is null. Without an explicit emit here the parent's
    // selectedEntity stays null, no metadata load fires, and the user sees a
    // dropdown labeled (e.g.) "Accomplishment records" with an empty column
    // list. Auto-pick the first entity so the displayed label and the loaded
    // fields agree from the first paint.
    if (!props.modelValue && entities.value.length > 0) {
      emit('update:modelValue', entities.value[0].name)
    }
  }
  catch (e: any) { error.value = e.message }
})

function onChange(e: any) { emit('update:modelValue', e.detail?.selectedOption?.value) }
</script>

<template>
  <div class="picker">
    <ui5-select @change="onChange" :value="props.modelValue || ''">
      <ui5-option v-for="e in entities" :key="e.name" :value="e.name">{{ e.label }}</ui5-option>
    </ui5-select>
    <div v-if="error" class="err">{{ error }}</div>
  </div>
</template>

<style scoped>
.picker { padding: 0.5rem; }
.err { color: var(--sapErrorColor); margin-top: 0.5rem; }
</style>
