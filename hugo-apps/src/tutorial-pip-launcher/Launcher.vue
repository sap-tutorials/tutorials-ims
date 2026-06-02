<!-- hugo-apps/src/tutorial-pip-launcher/Launcher.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { usePipLifecycle } from './usePipLifecycle';
import type { StepPayload } from '../shared/pip-types';

const props = defineProps<{
  slug: string;
  steps: StepPayload[];
  initialActiveStep: number;
}>();

const { pipWindow, open, close } = usePipLifecycle({
  slug: props.slug,
  getActiveStep: () => {
    // Prefer U1's `window.opGetCurrentStep()` (viewport-based; the source of
    // truth on the Object Page) — it survived the issue #170 removal of the
    // legacy step-TOC partial. Fall back to .step-toc-item.active for the
    // legacy `single.html` layout which still renders the step-TOC.
    const op = (window as any).opGetCurrentStep;
    if (typeof op === 'function') {
      const got = op();
      if (got && Number.isFinite(got.n)) return got.n;
    }
    const active = document.querySelector<HTMLElement>('.step-toc-item.active');
    const idx = active ? parseInt(active.dataset.tocStep || '', 10) : props.initialActiveStep;
    return Number.isFinite(idx) ? idx : props.initialActiveStep;
  },
  getSteps: () => props.steps,
});

const isOpen = computed(() => !!pipWindow.value);

async function onClick() {
  if (isOpen.value) {
    close();
  } else {
    const ok = await open();
    if (!ok) {
      const toast = document.querySelector<HTMLElement>('#tutorial-pip-toast');
      if (toast) (toast as any).show?.();
    }
  }
}
</script>

<template>
  <ui5-button
    :icon="isOpen ? 'navigation-down-arrow' : 'navigation-up-arrow'"
    :tooltip="isOpen ? 'Close pop-out window' : 'Pop out current step'"
    @click="onClick"
  />
  <ui5-toast id="tutorial-pip-toast" placement="BottomCenter" duration="3500">
    Pop-out window blocked. Check site permissions and try again.
  </ui5-toast>
</template>
