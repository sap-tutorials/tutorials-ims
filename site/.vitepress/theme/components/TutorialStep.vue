<script setup lang="ts">
import { ref, computed, inject } from 'vue'
import { useApi } from '../composables/useApi'

const props = defineProps<{
  number: number
  title: string
  slug: string
}>()

const completedSteps = inject<import('vue').Ref<Set<number>>>('completedSteps', ref(new Set()))
const onStepCompleted = inject<(n: number) => void>('onStepCompleted', () => {})

const isCompleted = computed(() => completedSteps.value.has(props.number))
const expanded = ref(true)
const completing = ref(false)
const { post, error } = useApi()

async function markDone() {
  completing.value = true
  await post(`/tutorials/${props.slug}/steps/${props.number}/complete`)
  completing.value = false
  if (!error.value) {
    onStepCompleted(props.number)
  }
}

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="tutorial-step" :class="{ 'is-completed': isCompleted }">
    <div class="step-header fd-panel__header" @click="toggle">
      <span class="step-number">{{ number }}</span>
      <span class="step-title">{{ title }}</span>
      <span v-if="isCompleted" class="step-check">&#10003;</span>
      <span class="step-toggle">{{ expanded ? '▲' : '▼' }}</span>
    </div>
    <div v-show="expanded" class="step-content">
      <slot />
      <div v-if="!isCompleted" class="step-actions">
        <button
          class="fd-button fd-button--emphasized"
          :disabled="completing"
          @click="markDone"
        >
          {{ completing ? 'Saving...' : 'Done' }}
        </button>
        <p v-if="error" class="step-error">Failed to save progress. Try again.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tutorial-step {
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.5rem;
  margin-bottom: 1rem;
  overflow: hidden;
}
.step-header {
  display: flex;
  align-items: center;
  padding: 0.75rem 1rem;
  cursor: pointer;
  background: var(--sapNeutralBackground, #f5f6f7);
  gap: 0.75rem;
}
.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  background: var(--sapBrandColor, #0070f2);
  color: #fff;
  font-weight: 600;
  font-size: 0.875rem;
  flex-shrink: 0;
}
.is-completed .step-number {
  background: var(--sapPositiveColor, #107e3e);
}
.step-title {
  flex: 1;
  font-weight: 600;
}
.step-check {
  color: var(--sapPositiveColor, #107e3e);
  font-size: 1.25rem;
}
.step-toggle {
  color: var(--sapNeutralTextColor, #6a6d70);
  font-size: 0.75rem;
}
.step-content {
  padding: 1rem;
}
.step-actions {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
}
.step-error {
  color: var(--sapNegativeColor, #b00);
  margin-top: 0.5rem;
  font-size: 0.875rem;
}
</style>
