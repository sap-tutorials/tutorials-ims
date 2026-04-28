<script setup lang="ts">
import { ref, computed, inject, watch } from 'vue'
import { useApi } from '../composables/useApi'
import StepValidation from './StepValidation.vue'

interface ValidationQuestion {
  id: string
  question: string
  type: 'multiple-choice' | 'text'
  options?: string[]
  correctAnswer: string
}

const props = defineProps<{
  number: number
  title: string
  slug: string
}>()

const completedSteps = inject<import('vue').Ref<Set<number>>>('completedSteps', ref(new Set()))
const onStepCompleted = inject<(n: number) => void>('onStepCompleted', () => {})
const allExpanded = inject<import('vue').Ref<boolean | null>>('allExpanded', ref(null))
const stepValidationMap = inject<import('vue').Ref<Record<number, ValidationQuestion[]>>>('stepValidationMap', ref({}))

const isCompleted = computed(() => completedSteps.value.has(props.number))
const expanded = ref(props.number === 1)
const completing = ref(false)
const validationPassed = ref(false)
const { post } = useApi()

const validation = computed(() => stepValidationMap.value[props.number] ?? [])
const hasValidation = computed(() => validation.value.length > 0)
const canComplete = computed(() => !hasValidation.value || validationPassed.value)

watch(allExpanded, (val) => {
  if (val !== null) expanded.value = val
})

function onValidated() {
  validationPassed.value = true
}

function markDone() {
  completing.value = true
  onStepCompleted(props.number)
  post(`/tutorials/${props.slug}/steps/${props.number}/complete`).catch(() => {})
  completing.value = false
}

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div :id="'step-' + number" class="tutorial-step" :class="{ 'is-completed': isCompleted }">
    <div class="step-header" @click="toggle">
      <span class="step-check-circle" :class="{ completed: isCompleted }">
        <span v-if="isCompleted">&#10003;</span>
      </span>
      <div class="step-header-text">
        <span class="step-label">Step {{ number }}</span>
        <span class="step-title-text">{{ title }}</span>
      </div>
      <span class="step-toggle-icon">{{ expanded ? '—' : '+' }}</span>
    </div>
    <div v-if="expanded" class="step-body">
      <hr class="step-divider" />
      <div class="step-content">
        <slot />
      </div>
      <StepValidation
        v-if="hasValidation && !isCompleted"
        :questions="validation"
        @validated="onValidated"
      />
      <div v-if="!isCompleted && canComplete" class="step-actions">
        <button
          class="fd-button fd-button--emphasized"
          :disabled="completing"
          @click="markDone"
        >
          {{ completing ? 'Saving...' : 'Done' }}
        </button>
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
  background: var(--sapBaseColor, #fff);
  box-shadow: var(--sapContent_Shadow0, 0 1px 4px rgba(0, 0, 0, 0.06));
}
.step-header {
  display: flex;
  align-items: flex-start;
  padding: 1rem 1.25rem;
  cursor: pointer;
  gap: 1rem;
  user-select: none;
}
.step-check-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--sapNeutralBorderColor, #bcc3ca);
  color: transparent;
  font-size: 0.875rem;
  flex-shrink: 0;
  margin-top: 0.125rem;
  transition: all 0.2s;
}
.step-check-circle.completed {
  background: var(--sapPositiveColor, #107e3e);
  border-color: var(--sapPositiveColor, #107e3e);
  color: #fff;
}
.step-header-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.step-label {
  text-transform: uppercase;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--sapNeutralTextColor, #6a6d70);
}
.step-title-text {
  font-size: 1.25rem;
  font-weight: 400;
  color: var(--sapBrandColor, #0070f2);
  line-height: 1.3;
}
.step-toggle-icon {
  font-size: 1.5rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  flex-shrink: 0;
  line-height: 1;
}
.step-body {
  padding: 0 1.25rem 1.25rem;
}
.step-divider {
  border: none;
  border-top: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  margin: 0 0 1rem;
}
.step-content {
  line-height: 1.7;
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
