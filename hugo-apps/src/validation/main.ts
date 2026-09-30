// hugo-apps/src/validation/main.ts
import { createApp } from 'vue';
import Validation from './Validation.vue';
import type { ValidationQuestion } from './grading';
import { shuffleArray } from '@shared/shuffle';

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

  const slug = (document.documentElement.dataset.pageSlug ?? '').toLowerCase();
  const stepByNum = new Map(steps.map(s => [s.number, s]));

  document.querySelectorAll('.step-validation-mount').forEach(el => {
    const host = el as HTMLElement;
    const stepNum = Number(host.dataset.step ?? 0);
    const step = stepByNum.get(stepNum);
    if (!step?.validation?.length) return;
    // [#655] Preview-mode signals from Hugo (see Task 5). Absent in prod —
    // Vue's .mount(el) replaces the host element, so we read these BEFORE
    // mount and pass them as props rather than reading them in onMounted.
    const isPreview = host.dataset.preview === 'true';
    const aiInvolved = host.dataset.aiInvolved === 'true';
    const rulesBlockId = host.dataset.rulesBlockId;
    // [#2558] Randomize MCQ answer order per page load so positional
    // answer-sharing ("it's the 3rd option") stops working. Grading is
    // string-based (see grading.ts), so reordering options is safe and needs
    // no change to correctAnswer/correctAnswers. Text questions have no
    // options and pass through unchanged.
    const questions = step.validation.map((q) =>
      q.type === 'multiple-choice' && q.options
        ? { ...q, options: shuffleArray(q.options) }
        : q,
    );
    createApp(Validation, {
      stepNumber: stepNum,
      slug,
      questions,
      isPreview,
      aiInvolved,
      rulesBlockId,
    }).mount(host);
  });
}
