// hugo-apps/src/tutorial-pip/useStepNavigation.ts
import type { Ref } from 'vue';
import { csrfFetch } from '@shared/csrf-fetch';
import type { StepPayload } from '../shared/pip-types';

export function useStepNavigation(
  slug: string,
  steps: StepPayload[],
  activeStep: Ref<number>
) {
  const minIndex = steps[0]?.stepIndex ?? 1;
  const maxIndex = steps[steps.length - 1]?.stepIndex ?? 1;

  function clamp(idx: number): number | null {
    if (!Number.isFinite(idx)) return null;
    if (idx < minIndex || idx > maxIndex) return null;
    return idx;
  }

  return {
    next() {
      const target = activeStep.value + 1;
      if (target <= maxIndex) activeStep.value = target;
    },
    prev() {
      const target = activeStep.value - 1;
      if (target >= minIndex) activeStep.value = target;
    },
    goto(idx: number) {
      const c = clamp(idx);
      if (c !== null) activeStep.value = c;
    },
    async completeStep(stepIndex: number): Promise<boolean> {
      try {
        const res = await csrfFetch('/api/completeStep', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, stepNumber: stepIndex }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
