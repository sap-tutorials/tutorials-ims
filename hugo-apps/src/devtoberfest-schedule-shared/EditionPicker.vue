<script setup lang="ts">
import type { Edition } from './types';

const props = defineProps<{
  editions: Edition[];
  modelValue: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  emit('update:modelValue', target.value);
}
</script>

<template>
  <div class="edition-picker">
    <label for="edition-select" class="edition-picker__label">Edition</label>
    <select
      id="edition-select"
      class="edition-picker__select"
      :value="modelValue ?? ''"
      @change="onChange"
    >
      <option v-for="ed in editions" :key="ed.id" :value="ed.id">
        {{ ed.name }}{{ ed.isCurrent ? ' (current)' : '' }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.edition-picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.edition-picker__label {
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapContent_LabelColor, #6a6d70);
  white-space: nowrap;
}

.edition-picker__select {
  font-family: var(--sapFontFamily, inherit);
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  background-color: var(--sapField_Background, #fff);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}

.edition-picker__select:focus {
  outline: none;
  border-color: var(--sapField_Focus_BorderColor, #0854a0);
  box-shadow: 0 0 0 2px var(--sapField_Focus_BorderColor, #0854a0);
}
</style>
