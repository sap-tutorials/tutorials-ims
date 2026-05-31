<!-- hugo-apps/src/tutorial-pip/PipShell.vue -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import FullMode from './FullMode.vue';
import ControllerMode from './ControllerMode.vue';
import { useStepNavigation } from './useStepNavigation';
import { createPipChannel } from '../shared/pip-channel';
import { savePipMode } from '../shared/pip-storage';
import type { PipMode, StepPayload, PipMessage } from '../shared/pip-types';

const props = defineProps<{
  slug: string;
  steps: StepPayload[];
  initialStepIndex: number;
  initialMode: PipMode;
}>();

const activeStep = ref(props.initialStepIndex);
const mode = ref<PipMode>(props.initialMode);
const errorMessage = ref<string | null>(null);
const tutorialComplete = ref(false);
const completing = ref(false);

const channel = createPipChannel(props.slug, 'pip');
const nav = useStepNavigation(props.slug, props.steps, activeStep);

const currentStep = computed(() =>
  props.steps.find(s => s.stepIndex === activeStep.value) ?? props.steps[0]
);
const isLastStep = computed(() => activeStep.value === props.steps[props.steps.length - 1]?.stepIndex);

function broadcastStep() {
  channel.send({ type: 'pip:stepChange', stepIndex: activeStep.value });
}

function handleNext() {
  nav.next();
  broadcastStep();
}
function handlePrev() {
  nav.prev();
  broadcastStep();
}
function handleGoto(idx: number) {
  nav.goto(idx);
  broadcastStep();
}
async function handleComplete(stepIndex: number) {
  if (completing.value) return;
  completing.value = true;
  try {
    errorMessage.value = null;
    const ok = await nav.completeStep(stepIndex);
    if (!ok) {
      errorMessage.value = 'Could not save completion. Please try again.';
      return;
    }
    channel.send({ type: 'pip:complete', stepIndex });
    const wasLast = isLastStep.value;
    const prevStep = activeStep.value;
    nav.next();
    if (activeStep.value !== prevStep) {
      channel.send({ type: 'pip:stepChange', stepIndex: activeStep.value });
    }
    if (wasLast) {
      tutorialComplete.value = true;
    }
  } finally {
    completing.value = false;
  }
}
function closePip() {
  window.close();
}
function handleToggleMode() {
  mode.value = mode.value === 'full' ? 'controller' : 'full';
  savePipMode(mode.value);
  channel.send({ type: 'pip:modeChange', mode: mode.value });
}

// Auto-collapse / auto-expand on resize threshold (300px tall).
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const h = e.contentRect.height;
      if (h < 300 && mode.value === 'full') {
        mode.value = 'controller';
        savePipMode('controller');
      } else if (h >= 300 && mode.value === 'controller') {
        mode.value = 'full';
        savePipMode('full');
      }
    }
  });
  ro.observe(document.documentElement);
});

// Subscribe to remote messages from the main tab.
const off = channel.on((msg: PipMessage) => {
  switch (msg.type) {
    case 'pip:stepChange':
      nav.goto(msg.stepIndex);
      break;
    case 'pip:complete':
      // Main tab marked it complete (e.g. user clicked in main tab).
      // No-op for active step; nav stays where it is.
      break;
    case 'pip:themeChange':
      document.documentElement.dataset.theme = msg.theme;
      if (msg.theme === 'dark') document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      break;
    case 'pip:closed':
      // Main tab is signaling it's gone away; we close ourselves.
      window.close();
      break;
  }
});

onBeforeUnmount(() => {
  off();
  ro?.disconnect();
  channel.send({ type: 'pip:closed' });
  channel.close();
});
</script>

<template>
  <div class="pip-shell" :data-mode="mode">
    <ui5-message-strip v-if="errorMessage" class="pip-error" design="Negative" hide-close-button>
      {{ errorMessage }}
    </ui5-message-strip>
    <div v-if="tutorialComplete" class="pip-completion">
      <h2>Tutorial complete <span aria-hidden="true">🎉</span></h2>
      <p>Nice work. You can close this window when you're ready.</p>
      <ui5-button design="Emphasized" @click="closePip">Close</ui5-button>
    </div>
    <FullMode
      v-else-if="mode === 'full'"
      :step="currentStep"
      :step-count="steps.length"
      :is-last="isLastStep"
      @next="handleNext"
      @prev="handlePrev"
      @complete="handleComplete"
      @toggle-mode="handleToggleMode"
    />
    <ControllerMode
      v-else
      :step="currentStep"
      :steps="steps"
      :active-step="activeStep"
      :is-last="isLastStep"
      @next="handleNext"
      @prev="handlePrev"
      @goto="handleGoto"
      @complete="handleComplete"
      @toggle-mode="handleToggleMode"
    />
  </div>
</template>

<style>
/* Unscoped on purpose — PipShell is the root component inside #tutorial-pip-mount
   and these rules also need to reach FullMode / ControllerMode children whose
   templates use the same .pip-* classes. The PiP document is its own isolated
   <html>, so global selectors can't bleed back into the main tab. */
.pip-shell {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--sapBaseColor, #fff);
  color: var(--sapTextColor, #32363a);
}
.pip-shell[data-mode='controller'] { overflow: hidden; }

.pip-error {
  flex: 0 0 auto;
  margin: 0.5rem 0.75rem;
}

.pip-completion {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1.5rem;
  text-align: center;
}
.pip-completion h2 {
  margin: 0;
  font-size: 1.25rem;
  color: var(--sapTextColor, #32363a);
}
.pip-completion p {
  margin: 0;
  color: var(--sapNeutralTextColor, #6a6d70);
  max-width: 28ch;
}
</style>
