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

const el = document.getElementById('tutorial-pip-launcher');
if (el && isPipSupported()) {
  const slug = el.dataset.slug || '';
  const parsedActiveStep = parseInt(el.dataset.activeStep || '1', 10);
  const initialActiveStep = Number.isFinite(parsedActiveStep) ? parsedActiveStep : 1;
  const steps = readStepsFromDom();
  if (slug && steps.length > 0) {
    createApp(Launcher, { slug, steps, initialActiveStep }).mount(el);
  }
}
