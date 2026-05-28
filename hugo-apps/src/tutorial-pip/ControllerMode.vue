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
