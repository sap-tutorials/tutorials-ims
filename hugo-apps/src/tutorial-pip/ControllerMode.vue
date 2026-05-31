<!-- hugo-apps/src/tutorial-pip/ControllerMode.vue -->
<script setup lang="ts">
import type { StepPayload } from '../shared/pip-types';
defineProps<{
  step: StepPayload;
  steps: StepPayload[];
  activeStep: number;
  isLast: boolean;
}>();
defineEmits<{
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'goto', stepIndex: number): void;
  (e: 'complete', stepIndex: number): void;
  (e: 'toggle-mode'): void;
}>();
</script>

<template>
  <div class="pip-controller">
    <span class="pip-controller__title" :title="step.heading">{{ step.heading }}</span>
    <ui5-button @click="$emit('prev')" icon="navigation-left-arrow" tooltip="Previous step" />
    <ui5-button @click="$emit('next')" icon="navigation-right-arrow" tooltip="Next step" />
    <div class="pip-controller__dots">
      <button
        v-for="s in steps"
        :key="s.stepIndex"
        type="button"
        class="pip-controller__dot"
        :class="{ active: s.stepIndex === activeStep }"
        :aria-label="`Go to step ${s.stepIndex}`"
        @click="$emit('goto', s.stepIndex)"
      />
    </div>
    <ui5-button design="Emphasized" @click="$emit('complete', step.stepIndex)">
      {{ isLast ? 'Finish' : 'Done' }}
    </ui5-button>
    <button type="button" class="pip-mode-toggle" @click="$emit('toggle-mode')" aria-label="Expand to full mode">⌄</button>
  </div>
</template>

<style>
.pip-controller {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  background: var(--sapBaseColor, #fff);
  border-top: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  min-height: 0;
}

.pip-controller__title {
  flex: 1 1 0;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pip-controller__dots {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 8rem;
  overflow: hidden;
}

.pip-controller__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  border: none;
  padding: 0;
  background: var(--sapNeutralBorderColor, #d9d9d9);
  cursor: pointer;
  transition: background 0.15s ease;
}
.pip-controller__dot:hover {
  background: var(--sapContent_LabelColor, #556b82);
}
.pip-controller__dot.active {
  background: var(--sapBrandColor, #0070f2);
}
.pip-controller__dot:focus-visible {
  outline: 2px solid var(--sapBrandColor, #0070f2);
  outline-offset: 1px;
}
</style>
