// hugo-apps/src/tutorial-pip/main.ts
// Mount entry called by the launcher INSIDE the popped-out PiP window.
// The launcher copies CSS, then writes a <div id="tutorial-pip-mount"> into
// the PiP document and dispatches a custom event with the payload.

import { createApp } from 'vue';
import PipShell from './PipShell.vue';
import type { PipMode, StepPayload } from '../shared/pip-types';

export type PipBootstrap = {
  slug: string;
  steps: StepPayload[];
  initialStepIndex: number;
  initialMode: PipMode;
};

export function mountPip(doc: Document, payload: PipBootstrap): void {
  const el = doc.getElementById('tutorial-pip-mount');
  if (!el) return;
  createApp(PipShell, payload).mount(el);
}

// Allow the launcher to call into us via global on the PiP window.
(globalThis as any).__mountTutorialPip = mountPip;
