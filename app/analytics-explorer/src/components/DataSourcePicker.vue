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
  try { entities.value = await getCachedEntityMetadata() }
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
