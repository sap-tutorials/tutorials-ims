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
    <!-- step.html is sanitized at Hugo build time by scripts/parsers/sanitize-html.ts -->
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

<style>
/* Unscoped — sibling components (ControllerMode) reuse .pip-mode-toggle and the
   PiP document is isolated, so we don't risk leaking these selectors. */
.pip-full {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0; /* allow the body to shrink so overflow-y works */
}

.pip-full__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  background: var(--sapObjectHeader_Background, #fff);
}
.pip-full__header h2 {
  flex: 1 1 auto;
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--sapTextColor, #32363a);
  /* clamp long headings to two lines instead of pushing the body down */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.pip-mode-toggle {
  flex: 0 0 auto;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.25rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--sapButton_Lite_TextColor, #0064d9);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}
.pip-mode-toggle:hover {
  background: var(--sapButton_Lite_Hover_Background, rgba(0, 100, 217, 0.06));
}
.pip-mode-toggle:focus-visible {
  outline: 2px solid var(--sapBrandColor, #0070f2);
  outline-offset: 2px;
}

.pip-full__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.875rem 1rem 1rem;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--sapTextColor, #32363a);
}

/* Make the injected step HTML behave inside a 480px column. The source
   markup was sized for a desktop tutorial column; cap images, soft-wrap
   code, and keep nested lists from causing horizontal scroll. */
.pip-full__body :deep(img),
.pip-full__body :deep(video),
.pip-full__body :deep(picture) {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0.5rem auto;
  border-radius: 0.25rem;
}
.pip-full__body :deep(pre),
.pip-full__body :deep(code) {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8125rem;
}
.pip-full__body :deep(pre) {
  padding: 0.625rem 0.75rem;
  background: var(--sapNeutralBackground, #f5f6f7);
  border-radius: 0.25rem;
  overflow-x: auto;
}
.pip-full__body :deep(table) {
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.pip-full__body :deep(h1),
.pip-full__body :deep(h2),
.pip-full__body :deep(h3),
.pip-full__body :deep(h4) {
  margin: 1rem 0 0.4rem;
  line-height: 1.3;
}
.pip-full__body :deep(p),
.pip-full__body :deep(ul),
.pip-full__body :deep(ol) {
  margin: 0.4rem 0 0.6rem;
}
.pip-full__body :deep(a) {
  color: var(--sapLinkColor, #0064d9);
}
/* Step-isolation: the launcher copies a single step's `.step-content innerHTML`
   into v-html, so there should not be sibling .tutorial-step nodes here. Belt
   and braces: hide anything that smuggles its way in (page chrome, side nav,
   hero promos) — see usePipLifecycle.ts for the cloned-stylesheet hygiene. */
.pip-full__body :deep(.tutorial-side-nav),
.pip-full__body :deep(.mission-side-nav),
.pip-full__body :deep(#progress-bar),
.pip-full__body :deep(#joule-fab),
.pip-full__body :deep(.shellbar) {
  display: none !important;
}

.pip-full__footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  background: var(--sapPageFooter_Background, #fff);
  position: sticky;
  bottom: 0;
}
.pip-step-count {
  flex: 1 1 auto;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  font-variant-numeric: tabular-nums;
}
</style>
