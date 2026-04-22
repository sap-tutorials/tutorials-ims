<script setup lang="ts">
import { ref, inject, computed } from 'vue'

const props = defineProps<{
  number: number
  title: string
  slug: string
}>()

const completedSteps = inject<import('vue').Ref<Set<number>>>('completedSteps', ref(new Set()))
const onStepCompleted = inject<(n: number) => void>('onStepCompleted', () => {})
const isCompleted = computed(() => completedSteps.value.has(props.number))
const isOpen = ref(props.number === 1)

function toggle() { isOpen.value = !isOpen.value }
function markDone() { onStepCompleted(props.number) }
</script>

<template>
  <div class="tutorial-step" :class="{ completed: isCompleted }">
    <div class="step-header" @click="toggle">
      <span class="step-number">Step {{ number }}</span>
      <span class="step-title">{{ title }}</span>
      <span v-if="isCompleted" class="step-done">Done</span>
    </div>
    <div v-show="isOpen" class="step-content">
      <slot />
      <button v-if="!isCompleted" class="fd-button" @click="markDone">Done</button>
    </div>
  </div>
</template>

<style scoped>
.tutorial-step { border: 1px solid var(--sapNeutralBorderColor, #d9d9d9); border-radius: 4px; margin: 1rem 0; }
.step-header { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; cursor: pointer; background: var(--sapObjectHeader_Background, #fff); }
.step-number { font-weight: bold; color: var(--sapBrandColor, #0070f2); }
.step-done { color: var(--sapPositiveColor, #2b7d2b); margin-left: auto; }
.step-content { padding: 1rem; border-top: 1px solid var(--sapNeutralBorderColor, #d9d9d9); }
.completed .step-header { background: var(--sapSuccessBackground, #f1fdf1); }
</style>
