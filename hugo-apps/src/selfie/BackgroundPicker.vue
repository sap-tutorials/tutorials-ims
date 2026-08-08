<script setup lang="ts">
import { BACKGROUNDS, backgroundUrl } from './backgrounds'

defineProps<{ background: string; imgBase: string }>()
const emit = defineEmits<{ 'update:background': [id: string] }>()
</script>
<template>
  <div class="selfie-bg-controls" role="group" aria-label="Background scene">
    <button
      type="button" class="selfie-btn selfie-bg-btn"
      :class="{ 'is-active': background === 'none' }"
      data-testid="bg-none" :aria-pressed="background === 'none'"
      @click="emit('update:background', 'none')"
    >None</button>
    <button
      v-for="b in BACKGROUNDS" :key="b.id" type="button"
      class="selfie-bg-thumb"
      :class="{ 'is-active': background === b.id }"
      :data-testid="`bg-${b.id}`" :aria-pressed="background === b.id"
      :title="b.label"
      @click="emit('update:background', b.id)"
    >
      <img :src="backgroundUrl(imgBase, b.file)" :alt="b.label" loading="lazy" />
    </button>
  </div>
</template>
