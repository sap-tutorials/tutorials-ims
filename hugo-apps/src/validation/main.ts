// hugo-apps/src/validation/main.ts
import { createApp } from 'vue';
import Validation from './Validation.vue';
import type { ValidationQuestion } from './grading';

// Local type — matches the Hugo-emitted shape, declared here because the
// equivalent in tutorial.ts is being deleted as part of this PR.
interface StepData {
  number: number;
  validation?: ValidationQuestion[];
}

const dataEl = document.getElementById('tutorial-data');
if (dataEl) {
  let steps: StepData[];
  try {
    let parsed = JSON.parse(dataEl.textContent || '[]');
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    steps = parsed;
  } catch {
    steps = [];
  }

  const slug = (document.body.dataset.slug ?? '').toLowerCase();
  const stepByNum = new Map(steps.map(s => [s.number, s]));

  document.querySelectorAll('.step-validation-mount').forEach(el => {
    const stepNum = Number((el as HTMLElement).dataset.step ?? 0);
    const step = stepByNum.get(stepNum);
    if (!step?.validation?.length) return;
    createApp(Validation, {
      stepNumber: stepNum,
      slug,
      questions: step.validation
    }).mount(el as HTMLElement);
  });
}
