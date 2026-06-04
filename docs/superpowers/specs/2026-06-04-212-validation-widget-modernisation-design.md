# `[VALIDATE_N]` Validation Widget — UI5 Modernisation Design

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#212](https://github.com/sap-tutorials/tutorials-ims/issues/212)
**Date:** 2026-06-04
**Author:** Tom Jung (with Claude)

## Summary

Convert the existing imperative validation widget at `hugo/assets/js/tutorial.ts:333-447` into a Vue 3 island using UI5 web components, matching the U1-U18 modernisation pattern. The new island lives at `hugo-apps/src/validation/`, replaces the old code in the same PR, keeps client-side `correctAnswer` grading semantics for backward compat, and adds per-(slug, step) localStorage persistence so a learner who answered correctly doesn't get re-quizzed on the same step after a page reload.

#212 was originally filed under the (incorrect) premise that no validation widget existed. This refactor is the actually-useful follow-up: modernise the UI, add persistence, and prepare the integration seam that #209 will use to route AI-graded questions to a backend endpoint.

## Goals

1. Replace `tutorial.ts:333-447` (115 lines of imperative DOM rendering) with a Vue 3 component using UI5 web components, matching the pattern set by `tutorial-rating`, `code-check`, and the U1-U18 series.
2. Persist a learner's "answered correctly" state per `(tutorialSlug, stepNumber)` in localStorage so reloading the page doesn't ask the question again.
3. Keep the existing client-side grading semantics (case-insensitive equality on text answers, exact-match on multiple-choice) — no backend dependency for `#212`.
4. Establish the integration seam for #209: a `submit` handler that routes AI-graded questions to a backend endpoint when the question's `aiGrading` flag is set. (#209 implements that path; #212 just defines the seam.)

## Non-Goals

- No backend dependency. All grading remains client-side. The `correctAnswer` is still in the public `<script id="tutorial-data">` JSON; that's a documented trade-off that #209 (server-side AI grading) addresses.
- No change to the rules.vr parser or the build pipeline. `ValidationQuestion` shape stays the same.
- No change to the Hugo template's mount div location or class. `tutorial-step.html:17` stays at `<div class="step-validation-mount" data-step="{{ $number }}">`.
- No new schema or DB tables. localStorage is the only state store.

## Approach

The new island reads questions from the existing `<script id="tutorial-data">` JSON serialization (same source the current `tutorial.ts:initValidation()` reads). Vue components handle rendering and event flow; UI5 web components provide the visual primitives. A pure-function helper module (`grading.ts`) handles the grading + persistence logic for unit-testability.

The PR ships the new island AND deletes the legacy code in one commit-chain — clean replacement, no dual paths.

## Architecture

```
Hugo template (unchanged):                       New: hugo-apps/src/validation/
  hugo/layouts/shortcodes/tutorial-step.html       main.ts        — mounts on .step-validation-mount
    <div class="step-validation-mount"             Validation.vue — the component
         data-step="{{ $number }}">                grading.ts     — pure helper (testable)

Hugo template (modified):
  hugo/layouts/tutorials/u1-object-page.html
    + <script type="module" src="/js/validation.js" defer></script>

Hugo file (modified — legacy delete):
  hugo/assets/js/tutorial.ts
    - lines 333-447 (initValidation, renderQuiz, handleQuizSubmit, ValidationQuestion type)
    - call to initValidation() near line 500

hugo-apps/vite.config.ts (modified):
  + 'validation' entry registered
  + validationBudget() guard at 8 KB gzipped

New tests:
  test/unit/validation-grading.test.js — pure unit tests for grading.ts
```

## Data flow

The island reads questions from the existing `<script id="tutorial-data">` JSON element on tutorial pages (Hugo serializes `Page.Params.steps` there during build):

```ts
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
  } catch { steps = []; }

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
```

Slug source: `document.body.dataset.slug` (existing convention, used by `tutorial-rating` and `code-check`). The Hugo template at `hugo/layouts/tutorials/u1-object-page.html` already sets this attribute.

## The Vue component

`hugo-apps/src/validation/Validation.vue` — single-file component using `<script setup>`.

UI5 components used:
- `<ui5-radio-button>` for multiple-choice options. One per option, shared `name` attribute scoped per question.
- `<ui5-textarea>` for text answers (more space than `<ui5-input>` since some authored answers are full sentences).
- `<ui5-button design="Emphasized">` for the submit button.
- `<ui5-message-strip>` for pass/fail feedback. Designs: `Positive` for pass, `Negative` for fail. (`Information` reserved for #209's `partial` verdict.)

Props:
```ts
interface Props {
  stepNumber: number;
  slug: string;
  questions: ValidationQuestion[];
}
```

State:
```ts
const answers = ref<Record<string, string>>({});  // answers per question id
const submitted = ref(false);                      // has the learner clicked submit?
const result = ref<'correct' | 'incorrect' | null>(null);
```

### Multi-question per-step UX

A step can have multiple questions in its `validation` array (the parser returns an array per step). The current legacy `tutorial.ts` widget renders ALL questions in one form and grades them as one block: any incorrect → step is incorrect. This spec preserves that behavior:

- All questions for a step render together inside one Vue island instance.
- One `<ui5-button>` submits all answers at once.
- Grading is all-or-nothing: ALL questions must be correct for the step to pass.
- ONE `<ui5-message-strip>` shows the result for the whole step. Per-question incorrect highlighting is OUT OF SCOPE for this spike — a planner should NOT add inline error indicators per question. Adding them is a follow-up enhancement, not a regression if absent.
- localStorage persistence is per-step (one key per `(slug, stepNumber)`), not per-question.

Persistence:
- On mount: `readPersisted(slug, stepNumber)` — if returns `{ correct: true }`, set `submitted.value = true; result.value = 'correct'`. Renders the success state immediately (no form).
- On successful submit: `writePersisted(slug, stepNumber, true)`.
- Persistence only writes on `correct`. Failed attempts don't get cached — the learner can keep trying.

Template structure (sketch):
```html
<div class="validation-widget">
  <template v-if="submitted && result === 'correct'">
    <ui5-message-strip design="Positive" hide-close-button>
      Correct! Well done.
    </ui5-message-strip>
  </template>

  <template v-else>
    <form @submit.prevent="onSubmit">
      <fieldset v-for="(q, qi) in questions" :key="q.id">
        <legend>{{ q.question }}</legend>

        <template v-if="q.type === 'multiple-choice' && q.options">
          <label v-for="opt in q.options" :key="opt" class="option">
            <ui5-radio-button
              :name="`q-${stepNumber}-${qi}`"
              :value="opt"
              :text="opt"
              @change="answers[q.id] = opt"
            />
          </label>
        </template>

        <ui5-textarea
          v-else
          :placeholder="'Type your answer…'"
          @input="answers[q.id] = $event.target.value"
          rows="2"
        />
      </fieldset>

      <ui5-button design="Emphasized" type="Submit">
        Submit Answer
      </ui5-button>

      <ui5-message-strip
        v-if="submitted && result === 'incorrect'"
        design="Negative"
        hide-close-button
      >
        Not quite — give it another try.
      </ui5-message-strip>
    </form>
  </template>
</div>
```

Submit handler:
```ts
function onSubmit() {
  submitted.value = true;
  const { correct } = gradeAnswers(props.questions, answers.value);
  result.value = correct ? 'correct' : 'incorrect';
  if (correct) writePersisted(props.slug, props.stepNumber, true);
}
```

#209's later integration adds an async branch in `onSubmit` that calls `/api/validate-answer` for any question with `aiGrading: true`. For #212, all questions go through `gradeAnswers` synchronously.

## The grading.ts helper

Pure module — no DOM access, no localStorage access (those happen in the Vue component which calls into this). Extracted so it's unit-testable.

```ts
// hugo-apps/src/validation/grading.ts

export interface ValidationQuestion {
  id: string;
  question: string;
  type: 'multiple-choice' | 'text';
  options?: string[];
  correctAnswer: string;
  aiGrading?: boolean; // reserved for #209
}

export interface GradingResult {
  correct: boolean;
  perQuestion: Array<{ id: string; correct: boolean }>;
}

/**
 * Grade an answer set against a question set. Pure: no I/O.
 * Multiple-choice: exact equality.
 * Text: case-insensitive equality after trim.
 */
export function gradeAnswers(
  questions: ValidationQuestion[],
  answers: Record<string, string>
): GradingResult {
  const perQuestion = questions.map(q => {
    const submitted = (answers[q.id] ?? '').trim();
    if (q.type === 'multiple-choice') {
      return { id: q.id, correct: submitted === q.correctAnswer };
    }
    return {
      id: q.id,
      correct: submitted.toLowerCase() === q.correctAnswer.toLowerCase()
    };
  });
  return { correct: perQuestion.every(r => r.correct), perQuestion };
}

const PERSIST_PREFIX = 'tutorial-validation-';

export function persistKey(slug: string, stepNumber: number): string {
  return `${PERSIST_PREFIX}${slug}-${stepNumber}`;
}

/**
 * Read the persisted "answered correctly" flag for a (slug, step).
 * Tolerant of localStorage failures (private mode, quota); returns null on any error.
 */
export function readPersisted(slug: string, stepNumber: number): { correct: boolean } | null {
  try {
    const raw = localStorage.getItem(persistKey(slug, stepNumber));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.correct === true ? { correct: true } : null;
  } catch {
    return null;
  }
}

/**
 * Write the "answered correctly" flag. Only persists on `correct: true`.
 * Silent on failure (private mode, quota).
 */
export function writePersisted(slug: string, stepNumber: number, correct: boolean): void {
  if (!correct) return;
  try {
    localStorage.setItem(
      persistKey(slug, stepNumber),
      JSON.stringify({ correct: true, timestamp: Date.now() })
    );
  } catch {
    // private mode or quota exceeded — silent
  }
}
```

## Hugo template change

Single line added to `hugo/layouts/tutorials/u1-object-page.html` near the existing `code-check.js` script tag (around line 387). **Use a separate `{{ if not site.Params.previewMode }}` guard — NOT the same `qa AND previewMode` block as `code-check.js`.**

The validation widget is purely client-side with no backend dependency or feature flag. It MUST run in QA mode so authors previewing their own `[VALIDATE_N]` blocks on `tutorials-srv-qa` can verify their questions render correctly. It must NOT run in preview mode because preview mode renders generic samples that aren't real tutorial content. So the guard is `previewMode` only:

```html
{{ if not site.Params.previewMode }}<script type="module" src="/js/validation.js" defer></script>{{ end }}
```

`code-check.js` adds the QA exclusion because its endpoint is gated on `ChatSettings.codeCheckEnabled` (a runtime flag) — the QA srv may not have that flag set, so the script would only show a confusing 503. The validation widget has no such gate; it just renders questions from the same frontmatter QA mode already builds.

## Removal of legacy code

In the same PR:

1. Delete `hugo/assets/js/tutorial.ts` lines 333-447: the `ValidationQuestion` interface, `StepData` interface, `initValidation`, `renderQuiz`, `handleQuizSubmit` functions.
2. Delete the call to `initValidation()` near line 500.
3. Search for and remove CSS classes that only the legacy markup used: `.step-validation`, `.option-card`, `.fd-input` (only when used inside a validation form), `.validation-feedback`, `.validation-success`, `.validation-error`. Verify none of these are referenced from outside the validation widget before removal — global grep across `hugo/assets/css/`, `hugo/static/css/`, all layouts.

## Testing

### Unit tests: `test/unit/validation-grading.test.js`

Cover the `grading.ts` helper module (pure, no DOM, no localStorage at the unit level — but the test can stub `globalThis.localStorage`):

1. `gradeAnswers` returns correct for a single multiple-choice question with the right answer selected.
2. `gradeAnswers` returns incorrect for a single multiple-choice question with the wrong answer.
3. `gradeAnswers` returns correct for a single text question with case-different but otherwise-matching answer.
4. `gradeAnswers` returns correct for a text question with leading/trailing whitespace differences.
5. `gradeAnswers` mixed quiz: any incorrect → overall incorrect; all correct → overall correct.
6. `persistKey(slug, step)` returns `tutorial-validation-${slug}-${step}` (format guarantee).
7. `readPersisted` returns null when no entry exists.
8. `readPersisted` returns null for malformed JSON in localStorage.
9. `readPersisted` returns `{ correct: true }` for a valid entry with `correct: true`.
10. `writePersisted` writes to localStorage when `correct === true`.
11. `writePersisted` does NOT write when `correct === false`.
12. `writePersisted` swallows errors (e.g. quota exceeded) silently.

### Manual smoke

Run `npm run dev` against a known tutorial with `[VALIDATE_N]` content. Verify:
- Multiple-choice question renders with `<ui5-radio-button>` options.
- Text question renders with `<ui5-textarea>`.
- Submit button is `<ui5-button design="Emphasized">`.
- Pass shows green `<ui5-message-strip>`; fail shows red.
- Reload after a successful submit → success state appears immediately, form is gone.
- Open DevTools → localStorage → see `tutorial-validation-${slug}-${step}` key with `{correct: true, timestamp: …}`.

### No hybrid/smoke tests for #212

The widget is purely client-side; no backend involved. Hybrid + smoke suites are reserved for #209's backend integration.

## Bundle budget

8 KB gzipped, matching `code-check.js`. Vite plugin `validationBudget()` follows the pattern at `hugo-apps/vite.config.ts:10-26` (the existing `codeCheckBudget`). Build fails if exceeded.

Estimate: the component is ~150 LOC TypeScript + Vue template, helper is ~50 LOC, both tree-shaken with Vue's runtime — should land at 2-3 KB gzipped, well within budget. UI5 components are loaded globally via `ui5-bootstrap.ts`, not bundled into the island.

`<ui5-radio-button>` is NOT currently in the global bootstrap — needs to be added at `hugo/assets/js/ui5-bootstrap.ts`:

```ts
import "@ui5/webcomponents/dist/RadioButton.js";
```

Add that import at line ~37 with the other UI5 component imports.

## Anti-leak handling

The `correctAnswer` field is still in the public `<script id="tutorial-data">` JSON shipped to every tutorial page. The new island reads it from there for client-side grading, exactly as the legacy `tutorial.ts` did.

This is documented as a known trade-off:
- The widget needs `correctAnswer` for client-side grading.
- It's been shipped to clients since the rules.vr loader was written.
- No learner-visible UX change is introduced by this PR.
- Anti-leak is addressed by #209 (server-side AI grading, no client-side `correctAnswer` needed for AI-graded questions).

A code comment in `Validation.vue` and in `grading.ts` notes the trade-off, links to #209, and explains why the client-side path is acceptable for the spike.

## Migration / Risk

**Low risk.** This is a UI rewrite with no schema change, no backend touch, no API contract change. The mount div, the data source (`#tutorial-data`), and the public Hugo frontmatter all stay identical. The only behavior change visible to learners is the new UI components (radio buttons → `<ui5-radio-button>`, plain input → `<ui5-textarea>`).

**Risk surface:** Any tutorial currently in production with `[VALIDATE_N]` rules will run through the new island after deploy. If the new island has a regression, ALL questions on ALL tutorials with validation rules break at once. Mitigations:
- Unit tests cover the grading logic (the only place a regression could silently change verdicts).
- Manual smoke before merge: at least one multiple-choice and one text question on a real tutorial.
- The new island falls back to no-op if `#tutorial-data` is missing or malformed (defensive parsing).

**Roll-forward path:** revert is one git commit. The legacy `tutorial.ts` code is in git history.

## Documentation Updates

- New developer-facing reference at `docs/developers/architecture/validation-widget.md` (~30 lines): how the island reads questions, the localStorage persistence shape, where to add a new question type, and the documented `correctAnswer` leak with cross-reference to #209.

## Acceptance Criteria

- [ ] `hugo-apps/src/validation/main.ts`, `Validation.vue`, and `grading.ts` shipped.
- [ ] Bundle: `validation.js` ≤ 8 KB gzipped, validated by `validationBudget()` Vite plugin.
- [ ] `hugo/layouts/tutorials/u1-object-page.html` adds `<script type="module" src="/js/validation.js" defer>` next to the `code-check.js` line.
- [ ] `hugo/assets/js/tutorial.ts:333-447` deleted; `initValidation()` call removed.
- [ ] Legacy CSS classes (`.step-validation`, `.option-card`, `.validation-feedback`, etc.) removed if unused elsewhere.
- [ ] `<ui5-radio-button>` registered in `hugo/assets/js/ui5-bootstrap.ts`.
- [ ] All 12 unit-test cases in `test/unit/validation-grading.test.js` pass.
- [ ] Manual smoke against a real tutorial: multiple-choice + text questions render correctly; pass + fail feedback render; reload after pass shows success state.
- [ ] No regression on tutorials without validation rules (the island is a no-op when no `.step-validation-mount` element exists).
- [ ] `docs/developers/architecture/validation-widget.md` shipped + sidebar registration.

## Open Questions

None outstanding. All design decisions answered during brainstorming.
