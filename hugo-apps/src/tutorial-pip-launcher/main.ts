// hugo-apps/src/tutorial-pip-launcher/main.ts
import { createApp } from 'vue';
import Launcher from './Launcher.vue';
import { isPipSupported } from './usePipLifecycle';
import type { StepPayload } from '../shared/pip-types';

const el = document.getElementById('tutorial-pip-launcher');
if (el && isPipSupported()) {
  const slug = el.dataset.slug || '';
  const initialActiveStep = parseInt(el.dataset.activeStep || '1', 10);
  const stepsScript = document.getElementById('tutorial-pip-steps') as HTMLScriptElement | null;
  let steps: StepPayload[] = [];
  if (stepsScript?.textContent) {
    try {
      steps = JSON.parse(stepsScript.textContent);
    } catch {
      steps = [];
    }
  }
  if (slug && steps.length > 0) {
    createApp(Launcher, { slug, steps, initialActiveStep }).mount(el);
  }
}
