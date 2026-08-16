// hugo-apps/src/tutorial-pip-launcher/main.ts
import { createApp } from 'vue';
import Launcher from './Launcher.vue';
import { isPipSupported } from './usePipLifecycle';
import type { StepPayload } from '../shared/pip-types';

function readStepsFromDom(): StepPayload[] {
  const nodes = document.querySelectorAll<HTMLElement>('.tutorial-step[data-step]');
  const steps: StepPayload[] = [];
  nodes.forEach(node => {
    const stepIndex = parseInt(node.dataset.step || '', 10);
    if (!Number.isFinite(stepIndex)) return;
    const heading = node.querySelector<HTMLElement>('.step-title-text')?.textContent?.trim() ?? '';
    const html = node.querySelector<HTMLElement>('.step-content')?.innerHTML ?? '';
    steps.push({ stepIndex, heading, html });
  });
  return steps.sort((a, b) => a.stepIndex - b.stepIndex);
}

// Defer the Vue mount to an idle frame so the PiP launcher button's
// initialization cost doesn't contribute to main-thread blocking time on
// tutorial pages. DOM is fully parsed by the time any type="module" script
// runs, so readStepsFromDom() is safe inside the callback.
// timeout:300 ensures the button appears within 300ms on a busy main thread.
const el = document.getElementById('tutorial-pip-launcher');
if (el && isPipSupported()) {
  const doMount = () => {
    const slug = el.dataset.slug || '';
    const parsedActiveStep = parseInt(el.dataset.activeStep || '1', 10);
    const initialActiveStep = Number.isFinite(parsedActiveStep) ? parsedActiveStep : 1;
    const steps = readStepsFromDom();
    if (slug && steps.length > 0) {
      createApp(Launcher, { slug, steps, initialActiveStep }).mount(el);
    }
  };
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(doMount, { timeout: 300 });
  } else {
    setTimeout(doMount, 0);
  }
}
