<script setup lang="ts">
import { POLAROID_STYLES, POLAROID_STYLE_IDS, type PolaroidStyleId } from './polaroid'

const props = defineProps<{
  enabled: boolean
  style: PolaroidStyleId
  name: string
}>()
const emit = defineEmits<{
  'update:enabled': [value: boolean]
  'update:style': [value: PolaroidStyleId]
  'update:name': [value: string]
}>()

const styles = POLAROID_STYLE_IDS.map((id) => ({ id, label: POLAROID_STYLES[id].label }))
</script>
<template>
  <div class="selfie-polaroid-controls">
    <label class="selfie-toggle">
      <input
        type="checkbox" :checked="enabled" data-testid="border-toggle"
        @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
      />
      Polaroid border
    </label>
    <template v-if="enabled">
      <div class="selfie-polaroid-styles" role="group" aria-label="Border style">
        <button
          v-for="s in styles" :key="s.id" type="button"
          class="selfie-btn selfie-polaroid-style"
          :class="{ 'is-active': s.id === style }"
          :data-testid="`border-style-${s.id}`"
          :aria-pressed="s.id === style"
          @click="emit('update:style', s.id)"
        >{{ s.label }}</button>
      </div>
      <input
        type="text" class="selfie-caption-input" data-testid="border-name"
        :value="name" placeholder="Your name (optional)"
        @input="emit('update:name', ($event.target as HTMLInputElement).value)"
      />
    </template>
  </div>
</template>
