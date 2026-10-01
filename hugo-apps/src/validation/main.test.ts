// @vitest-environment happy-dom
// hugo-apps/src/validation/main.test.ts
//
// #2558 — the validation island shuffles MCQ option order before mounting
// Validation.vue. Grading is string-based, so a shuffle must not change which
// option is correct. We mock @shared/shuffle to a deterministic reverse so the
// rendered order is asserted exactly.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic stand-in for the real Fisher-Yates: reverse the array.
// Keeps the test independent of Math.random while still proving main.ts
// re-orders options and preserves the element set.
vi.mock('@shared/shuffle', () => ({
  shuffleArray: (arr: unknown[]) => [...arr].reverse(),
}));

function bakePage(steps: unknown, mountSteps: number[]) {
  const mounts = mountSteps
    .map((n) => `<div class="step-validation-mount" data-step="${n}"></div>`)
    .join('');
  document.body.innerHTML =
    `<script id="tutorial-data" type="application/json">${JSON.stringify(steps)}</script>` +
    mounts;
}

async function runIsland() {
  vi.resetModules();
  await import('./main');
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-page-slug');
});

describe('validation island answer shuffle', () => {
  it('renders MCQ options in shuffled order but keeps the same option set', async () => {
    const steps = [
      {
        number: 1,
        validation: [
          {
            id: 'q1',
            question: 'Pick one',
            type: 'multiple-choice',
            options: ['alpha', 'bravo', 'charlie', 'delta'],
            correctAnswer: 'alpha',
          },
        ],
      },
    ];
    bakePage(steps, [1]);
    await runIsland();

    // Validation.vue renders one <ui5-radio-button> per option, in options order.
    const radios = [...document.querySelectorAll('ui5-radio-button')].map(
      (r) => r.getAttribute('text'),
    );
    // Reverse mock → deterministic order.
    expect(radios).toEqual(['delta', 'charlie', 'bravo', 'alpha']);
    // Same set, just reordered.
    expect([...radios].sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('leaves text questions (no options) untouched', async () => {
    const steps = [
      {
        number: 1,
        validation: [
          { id: 'q1', question: 'Explain', type: 'text', correctAnswer: 'because' },
        ],
      },
    ];
    bakePage(steps, [1]);
    await runIsland();
    expect(document.querySelector('ui5-textarea')).not.toBeNull();
    expect(document.querySelectorAll('ui5-radio-button')).toHaveLength(0);
  });
});
