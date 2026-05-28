<!-- hugo-apps/src/tutorial-pip/FullMode.vue -->
<script setup lang="ts">
import type { StepPayload } from '../shared/pip-types';
defineProps<{
  step: StepPayload;
  stepCount: number;
  isLast: boolean;
}>();
defineEmits<{
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'complete', stepIndex: number): void;
  (e: 'toggle-mode'): void;
}>();
</script>

<template>
  <div class="pip-full">
    <header class="pip-full__header">
      <h2>{{ step.heading }}</h2>
      <button type="button" class="pip-mode-toggle" @click="$emit('toggle-mode')" aria-label="Switch to controller mode">⌃</button>
    </header>
    <div class="pip-full__body" v-html="step.html" />
    <footer class="pip-full__footer">
      <ui5-button @click="$emit('prev')" icon="navigation-left-arrow" tooltip="Previous step" />
      <span class="pip-step-count">{{ step.stepIndex }} / {{ stepCount }}</span>
      <ui5-button @click="$emit('next')" icon="navigation-right-arrow" tooltip="Next step" />
      <ui5-button design="Emphasized" @click="$emit('complete', step.stepIndex)">
        {{ isLast ? 'Finish tutorial' : 'Mark complete' }}
      </ui5-button>
    </footer>
  </div>
</template>
