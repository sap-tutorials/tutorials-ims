<script setup lang="ts">
import { EFFECTS, EFFECT_IDS, type EffectId } from './effects'

defineProps<{ effect: EffectId }>()
const emit = defineEmits<{ 'update:effect': [value: EffectId] }>()

const effects = EFFECT_IDS.map((id) => ({ id, label: EFFECTS[id].label }))
</script>
<template>
  <div class="selfie-effect-controls" role="group" aria-label="Effect">
    <button
      v-for="e in effects" :key="e.id" type="button"
      class="selfie-btn selfie-effect-btn"
      :class="{ 'is-active': e.id === effect }"
      :data-testid="`effect-${e.id}`"
      :aria-pressed="e.id === effect"
      @click="emit('update:effect', e.id)"
    >{{ e.label }}</button>
  </div>
</template>
