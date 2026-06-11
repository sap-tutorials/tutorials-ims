<!-- hugo-apps/src/tutorial-branches/SkipPrompt.vue -->
<!--
  Issue #172 PR 3 — skip-step prompt.
  Renders a <ui5-message-strip> on a step that the decide endpoint flags as
  skip=true; user can accept (hide step body) or read anyway. Choice
  persisted to localStorage per (slug, stepNumber).
-->
<script setup lang="ts">
import { ref, onMounted, useTemplateRef } from 'vue';
import type { DecideResponse } from './decide';

interface Props {
  slug: string;
  stepNumber: number;
  skipLabel: string;
  skipReason: string;
  decisionsPromise: Promise<DecideResponse | null>;
}

const props = defineProps<Props>();

type Decision = 'pending' | 'skip' | 'read';

const storageKey = `tut.branch.skip.${props.slug}.${props.stepNumber}`;

function readPersisted(): Decision {
  try {
    const v = localStorage.getItem(storageKey);
    if (v === 'skip' || v === 'read') return v;
  } catch { /* ignore */ }
  return 'pending';
}

const decision = ref<Decision>(readPersisted());
const shouldShow = ref(false);
const mountedRef = useTemplateRef<HTMLElement>('mountedRef');

function hideStepBody() {
  const body = mountedRef.value?.closest('.step-body');
  if (body) body.setAttribute('hidden', '');
}

onMounted(async () => {
  // Apply persisted skip immediately (don't wait on the network).
  if (decision.value === 'skip') {
    hideStepBody();
    return;
  }
  if (decision.value === 'read') return;

  const decisions = await props.decisionsPromise;
  if (!decisions) return;
  const sp = decisions.skipPoints.find(s => s.stepNumber === props.stepNumber);
  if (!sp || !sp.skip) return;
  shouldShow.value = true;
});

function onSkip() {
  decision.value = 'skip';
  try { localStorage.setItem(storageKey, 'skip'); } catch { /* ignore */ }
  hideStepBody();
  shouldShow.value = false;
}

function onRead() {
  decision.value = 'read';
  try { localStorage.setItem(storageKey, 'read'); } catch { /* ignore */ }
  shouldShow.value = false;
}
</script>

<template>
  <div ref="mountedRef" class="skip-prompt">
    <ui5-message-strip
      v-if="shouldShow && decision === 'pending'"
      design="Information"
      hide-close-button
    >
      {{ skipReason }}
      <ui5-button design="Emphasized" @click="onSkip">{{ skipLabel }}</ui5-button>
      <ui5-button design="Transparent" @click="onRead">Read anyway</ui5-button>
    </ui5-message-strip>
  </div>
</template>

<style scoped>
.skip-prompt { margin: 0.75rem 0; }
</style>
