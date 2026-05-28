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
    // Read current step from DOM (U11 maintains data-toc-item.active).
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
