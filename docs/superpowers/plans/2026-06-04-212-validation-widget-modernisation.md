# Validation Widget UI5 Modernisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the imperative validation widget at `hugo/assets/js/tutorial.ts:333-447` with a Vue 3 island using UI5 web components, add per-(slug, step) localStorage persistence, and prepare an integration seam for #209 — all in one PR.

**Architecture:** New `hugo-apps/src/validation/` Vue island (main.ts + Validation.vue + grading.ts pure helper), registered as a `validation` entry in Vite with an 8 KB gzip budget. Hugo template loads the bundle via `<script type="module">` (gated on `not previewMode`, NOT the qa+previewMode block code-check.js uses). Mount class stays the same (`.step-validation-mount`); legacy `tutorial.ts` code is deleted in the same PR.

**Tech Stack:** Vue 3 + `<script setup>` + TypeScript, UI5 Web Components (`ui5-radio-button`, `ui5-textarea`, `ui5-button`, `ui5-message-strip`), Vite, Vitest.

**Spec:** [`docs/superpowers/specs/2026-06-04-212-validation-widget-modernisation-design.md`](../specs/2026-06-04-212-validation-widget-modernisation-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#212](https://github.com/sap-tutorials/tutorials-ims/issues/212)

---

## Working assumptions

- You will work on a feature branch `feature/212-validation-modernisation` cut from `spec/212-validation-modernisation` (or off `main` — both are fine; the spec branch is just the doc anchor).
- TDD discipline on the helper module. The Vue component itself is smoke-tested manually (no Vue Test Utils in the project).
- Branch hygiene: every commit verifies `git branch --show-current` shows the feature branch (per [feedback_verify_branch_before_commit](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md)).
- This work is purely client-side. No backend changes, no schema changes, no `cf login` needed for any task.
- Per [feedback_worktree_tests_hang](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md): `npm test` may hang in fresh worktrees. Run targeted test files instead of the full suite.

## Useful skills

- `superpowers:test-driven-development` — for the grading helper TDD discipline
- `superpowers:verification-before-completion` — before claiming a task done

## File map

**New files:**
- `hugo-apps/src/validation/main.ts` — discovery + mount logic (~25 lines)
- `hugo-apps/src/validation/Validation.vue` — the Vue 3 component (~150 lines)
- `hugo-apps/src/validation/grading.ts` — pure helper module: `gradeAnswers`, `persistKey`, `readPersisted`, `writePersisted` (~70 lines)
- `test/unit/validation-grading.test.js` — 12 unit cases for the helper module
- `docs/developers/architecture/validation-widget.md` — developer reference (~30 lines)

**Modified files:**
- `hugo-apps/vite.config.ts` — register `validation` entry + `validationBudget()` plugin (8 KB gzip cap)
- `hugo/assets/js/ui5-bootstrap.ts` — add `import "@ui5/webcomponents/dist/RadioButton.js";`
- `hugo/layouts/tutorials/u1-object-page.html` — add `<script type="module" src="/js/validation.js" defer>` inside `{{ if not site.Params.previewMode }}` block (NOT the qa+previewMode block)
- `hugo/assets/js/tutorial.ts` — delete lines 333-447 (`ValidationQuestion` interface, `StepData` interface, `initValidation`, `renderQuiz`, `handleQuizSubmit`) and the call to `initValidation()` near line 500
- `docs/.vitepress/config.ts` — sidebar registration for the new architecture doc

---

## Task 1: Vite entry + budget + UI5 bootstrap

**Files:**
- Modify: `hugo-apps/vite.config.ts`
- Modify: `hugo/assets/js/ui5-bootstrap.ts`

This is the infrastructure. No tests yet — this just makes the bundle build.

- [ ] **Step 1: Read the current vite.config.ts shape**

Read `hugo-apps/vite.config.ts` end-to-end. Note:
- `MAX_TUTORIAL_PREFS_GZIP` and `MAX_CODE_CHECK_GZIP` constants (top of file)
- `tutorialPrefsBudget()` and `codeCheckBudget()` plugins (each ~10 lines, identical shape)
- `rollupOptions.input` map (around line 65-80)
- `plugins: [...]` array

- [ ] **Step 2: Add `MAX_VALIDATION_GZIP` constant**

Near `MAX_CODE_CHECK_GZIP`:

```ts
const MAX_VALIDATION_GZIP = 8 * 1024;
```

- [ ] **Step 3: Add `validationBudget()` plugin**

Near `codeCheckBudget()`:

```ts
function validationBudget() {
  return {
    name: 'validation-budget',
    generateBundle(_options, bundle) {
      const chunk = bundle['validation.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_VALIDATION_GZIP) {
        this.error(`validation.js is ${gz} bytes gzipped (> ${MAX_VALIDATION_GZIP}). Move code to a lazy chunk.`);
      }
      this.warn(`validation.js: ${gz} bytes gzipped (budget ${MAX_VALIDATION_GZIP}).`);
    }
  };
}
```

- [ ] **Step 4: Register `validation` entry**

In `rollupOptions.input` add (preserving alphabetical order if the existing entries are alphabetical):

```ts
'validation': resolve(__dirname, 'src/validation/main.ts'),
```

- [ ] **Step 5: Add `validationBudget()` to plugins array**

Near where `codeCheckBudget()` is registered:

```ts
plugins: [
  vue(),
  // ...existing plugins
  codeCheckBudget(),
  validationBudget(),
  // ...
]
```

- [ ] **Step 6: Add `ui5-radio-button` to bootstrap**

In `hugo/assets/js/ui5-bootstrap.ts`, find the block of `@ui5/webcomponents/dist/<Component>.js` side-effect imports (around line 30-40). Add:

```ts
import "@ui5/webcomponents/dist/RadioButton.js";
```

(Maintain alphabetical order with the surrounding imports.)

- [ ] **Step 7: Verify the bundle builds (will fail because main.ts doesn't exist yet)**

Run: `cd hugo-apps && npx vite build` (or whatever the project's hugo-apps build command is — check `package.json` `scripts`).

Expected: build fails with `Could not resolve './src/validation/main.ts'` or similar. **This is expected** — the entry is registered but the file doesn't exist yet. Task 2/3 creates it.

If you get a different error (e.g. plugin syntax error in vite.config.ts), fix it before continuing.

- [ ] **Step 8: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/212-validation-modernisation" ] && \
  git add hugo-apps/vite.config.ts hugo/assets/js/ui5-bootstrap.ts && \
  git commit -m "feat(212): register validation Vite entry + ui5-radio-button bootstrap (#212)

- 'validation' entry in rollupOptions.input
- validationBudget() plugin with 8 KB gzip cap (matches code-check)
- ui5-radio-button registered globally so the new island can use
  <ui5-radio-button> without per-island registration.

Bundle won't actually build until Task 2 creates the source file.
This commit just stages the infrastructure."
```

---

## Task 2: `grading.ts` pure helper module (TDD)

**Files:**
- Create: `hugo-apps/src/validation/grading.ts`
- Create: `test/unit/validation-grading.test.js`

TDD: write the failing test, then the implementation.

- [ ] **Step 1: Write the failing test file**

Create `test/unit/validation-grading.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  gradeAnswers,
  persistKey,
  readPersisted,
  writePersisted
} from '../../hugo-apps/src/validation/grading.js';

describe('validation grading.ts', () => {
  // ── gradeAnswers ────────────────────────────────────────────────

  it('multiple-choice: correct answer selected → correct', () => {
    const questions = [{
      id: 'validate-1',
      question: 'Q?',
      type: 'multiple-choice',
      options: ['A', 'B', 'C'],
      correctAnswer: 'B'
    }];
    const result = gradeAnswers(questions, { 'validate-1': 'B' });
    expect(result.correct).toBe(true);
    expect(result.perQuestion).toEqual([{ id: 'validate-1', correct: true }]);
  });

  it('multiple-choice: wrong answer selected → incorrect', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'multiple-choice',
      options: ['A', 'B'], correctAnswer: 'B'
    }];
    expect(gradeAnswers(questions, { 'validate-1': 'A' }).correct).toBe(false);
  });

  it('text: case-different match → correct (case-insensitive)', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'Automation'
    }];
    expect(gradeAnswers(questions, { 'validate-1': 'AUTOMATION' }).correct).toBe(true);
  });

  it('text: leading/trailing whitespace → still matches', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'fields'
    }];
    expect(gradeAnswers(questions, { 'validate-1': '  fields  ' }).correct).toBe(true);
  });

  it('text: empty answer → incorrect', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'X'
    }];
    expect(gradeAnswers(questions, { 'validate-1': '' }).correct).toBe(false);
  });

  it('text: missing answer (undefined) → incorrect', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'X'
    }];
    expect(gradeAnswers(questions, {}).correct).toBe(false);
  });

  it('mixed quiz: any incorrect → overall incorrect', () => {
    const questions = [
      { id: 'q1', question: 'Q1?', type: 'multiple-choice', options: ['A', 'B'], correctAnswer: 'A' },
      { id: 'q2', question: 'Q2?', type: 'text', correctAnswer: 'fields' }
    ];
    const result = gradeAnswers(questions, { q1: 'A', q2: 'wrong' });
    expect(result.correct).toBe(false);
    expect(result.perQuestion).toEqual([
      { id: 'q1', correct: true },
      { id: 'q2', correct: false }
    ]);
  });

  it('mixed quiz: all correct → overall correct', () => {
    const questions = [
      { id: 'q1', question: 'Q1?', type: 'multiple-choice', options: ['A', 'B'], correctAnswer: 'A' },
      { id: 'q2', question: 'Q2?', type: 'text', correctAnswer: 'fields' }
    ];
    expect(gradeAnswers(questions, { q1: 'A', q2: 'fields' }).correct).toBe(true);
  });

  // ── persistKey ──────────────────────────────────────────────────

  it('persistKey: format is tutorial-validation-${slug}-${step}', () => {
    expect(persistKey('cap-getting-started', 3)).toBe('tutorial-validation-cap-getting-started-3');
  });

  // ── readPersisted ───────────────────────────────────────────────

  it('readPersisted: returns null when localStorage is empty', () => {
    const ls = { getItem: vi.fn(() => null) };
    vi.stubGlobal('localStorage', ls);
    expect(readPersisted('foo', 1)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('readPersisted: returns null for malformed JSON', () => {
    const ls = { getItem: vi.fn(() => 'not-json{{{') };
    vi.stubGlobal('localStorage', ls);
    expect(readPersisted('foo', 1)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('readPersisted: returns { correct: true } for a valid entry', () => {
    const ls = { getItem: vi.fn(() => JSON.stringify({ correct: true, timestamp: 123 })) };
    vi.stubGlobal('localStorage', ls);
    expect(readPersisted('foo', 1)).toEqual({ correct: true });
    vi.unstubAllGlobals();
  });

  // ── writePersisted ──────────────────────────────────────────────

  it('writePersisted: writes JSON when correct=true', () => {
    const ls = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', ls);
    writePersisted('foo', 1, true);
    expect(ls.setItem).toHaveBeenCalledTimes(1);
    expect(ls.setItem).toHaveBeenCalledWith(
      'tutorial-validation-foo-1',
      expect.stringMatching(/^\{"correct":true,"timestamp":\d+\}$/)
    );
    vi.unstubAllGlobals();
  });

  it('writePersisted: does NOT write when correct=false', () => {
    const ls = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', ls);
    writePersisted('foo', 1, false);
    expect(ls.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('writePersisted: swallows errors silently (private mode)', () => {
    const ls = {
      setItem: vi.fn(() => { throw new Error('quota exceeded'); })
    };
    vi.stubGlobal('localStorage', ls);
    expect(() => writePersisted('foo', 1, true)).not.toThrow();
    vi.unstubAllGlobals();
  });
});
```

Note: imports `from '../../hugo-apps/src/validation/grading.js'` — `.js` extension on `.ts` source is the project convention for ESM resolution.

- [ ] **Step 2: Run the tests, expect failure**

```bash
npx vitest run test/unit/validation-grading.test.js
```

Expected: `Cannot find module .../hugo-apps/src/validation/grading.js` or similar. Module doesn't exist yet.

- [ ] **Step 3: Implement `grading.ts`**

Create `hugo-apps/src/validation/grading.ts`:

```ts
// Pure helper module for the validation widget (issue #212).
// No DOM access, no localStorage access here — those happen in the
// Vue component which calls into this module's functions.
//
// Note: client-side correctAnswer comparison is a documented trade-off.
// The correctAnswer ships in the public <script id="tutorial-data"> JSON
// for every tutorial; this module just consumes it. Server-side grading
// is #209's territory (AI grader).

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
 * All-or-nothing aggregation: a single quiz's `correct` is true iff every
 * question is correct (the legacy widget's behaviour, preserved for #212).
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
 * Tolerant of localStorage failures (private mode, quota); returns null on any error
 * including malformed JSON.
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
 * Silent on failure (private mode, quota exceeded, etc).
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

- [ ] **Step 4: Run the tests, expect pass**

```bash
npx vitest run test/unit/validation-grading.test.js
```

Expected: 15 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/212-validation-modernisation" ] && \
  git add hugo-apps/src/validation/grading.ts test/unit/validation-grading.test.js && \
  git commit -m "feat(212): grading.ts pure helper module + 15 unit tests (#212)

- gradeAnswers: pure grading function (no I/O), all-or-nothing aggregation.
- persistKey/readPersisted/writePersisted: localStorage helpers, tolerant
  of private-mode failures.
- aiGrading? field on ValidationQuestion reserved for #209.

15 unit cases cover all paths including malformed JSON, missing
answers, case-insensitivity, and silent-failure under private mode."
```

---

## Task 3: `Validation.vue` + `main.ts`

**Files:**
- Create: `hugo-apps/src/validation/Validation.vue`
- Create: `hugo-apps/src/validation/main.ts`

The Vue component. No automated tests at the component level (manual smoke after Task 4 wires it up).

- [ ] **Step 1: Create `main.ts`**

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
```

- [ ] **Step 2: Create `Validation.vue`**

```vue
<!-- hugo-apps/src/validation/Validation.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  gradeAnswers,
  readPersisted,
  writePersisted,
  type ValidationQuestion
} from './grading';

interface Props {
  stepNumber: number;
  slug: string;
  questions: ValidationQuestion[];
}

const props = defineProps<Props>();

const answers = ref<Record<string, string>>({});
const submitted = ref(false);
const result = ref<'correct' | 'incorrect' | null>(null);

onMounted(() => {
  const persisted = readPersisted(props.slug, props.stepNumber);
  if (persisted?.correct) {
    submitted.value = true;
    result.value = 'correct';
  }
});

function onRadioChange(qid: string, value: string) {
  answers.value[qid] = value;
}

function onTextInput(qid: string, event: Event) {
  const target = event.target as HTMLInputElement | null;
  answers.value[qid] = target?.value ?? '';
}

function onSubmit() {
  submitted.value = true;
  const { correct } = gradeAnswers(props.questions, answers.value);
  result.value = correct ? 'correct' : 'incorrect';
  if (correct) writePersisted(props.slug, props.stepNumber, true);
}

function onTryAgain() {
  // Allow re-submit on incorrect: clear submitted state, keep answers so
  // the learner can adjust without re-typing. The form re-renders below.
  submitted.value = false;
  result.value = null;
}
</script>

<template>
  <div class="validation-widget">
    <!-- Persisted-success state: skip the form entirely -->
    <ui5-message-strip
      v-if="submitted && result === 'correct'"
      design="Positive"
      hide-close-button
    >
      Correct! Well done.
    </ui5-message-strip>

    <!-- Active form -->
    <form v-else @submit.prevent="onSubmit">
      <fieldset
        v-for="(q, qi) in questions"
        :key="q.id"
        class="validation-question"
      >
        <legend>{{ q.question }}</legend>

        <template v-if="q.type === 'multiple-choice' && q.options">
          <div v-for="opt in q.options" :key="opt" class="option-row">
            <ui5-radio-button
              :name="`q-${stepNumber}-${qi}`"
              :value="opt"
              :text="opt"
              @change="onRadioChange(q.id, opt)"
            />
          </div>
        </template>

        <ui5-textarea
          v-else
          placeholder="Type your answer…"
          :rows="2"
          @input="onTextInput(q.id, $event)"
        />
      </fieldset>

      <div class="validation-actions">
        <ui5-button design="Emphasized" type="Submit">
          Submit Answer
        </ui5-button>
      </div>

      <ui5-message-strip
        v-if="submitted && result === 'incorrect'"
        design="Negative"
        hide-close-button
      >
        Not quite — give it another try.
        <ui5-button slot="action" design="Default" @click="onTryAgain">
          Try Again
        </ui5-button>
      </ui5-message-strip>
    </form>
  </div>
</template>

<style scoped>
.validation-widget {
  margin: 1rem 0;
}
.validation-question {
  border: 1px solid var(--sapNeutralBorderColor, #e5e5e5);
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}
.validation-question legend {
  font-weight: 600;
  padding: 0 0.5rem;
}
.option-row {
  margin: 0.25rem 0;
}
.validation-actions {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
}
</style>
```

- [ ] **Step 3: Run the targeted unit tests (still 15 passing — Vue component change shouldn't break grading.ts)**

```bash
npx vitest run test/unit/validation-grading.test.js
```

Expected: 15 passing.

- [ ] **Step 3.5: Verify `<ui5-message-strip slot="action">` exists**

The plan's `Validation.vue` template wraps a Try Again button as `<ui5-button slot="action" ...>` inside `<ui5-message-strip>`. Verify the `action` slot exists on `ui5-message-strip` before relying on it. Use the UI5 MCP if available:

```
mcp__ui5-webcomponents__get_component_api { componentName: 'ui5-message-strip' }
```

If the MCP isn't available, check the UI5 docs site directly. If the `action` slot doesn't exist on `ui5-message-strip` in the project's UI5 version, the button will silently not render.

Fallback if the slot isn't available: move the Try Again button to a sibling element below the strip (still works the same; just different DOM structure):

```html
<ui5-message-strip
  v-if="submitted && result === 'incorrect'"
  design="Negative"
  hide-close-button
>
  Not quite — give it another try.
</ui5-message-strip>
<ui5-button
  v-if="submitted && result === 'incorrect'"
  design="Default"
  @click="onTryAgain"
  style="margin-top: 0.5rem;"
>
  Try Again
</ui5-button>
```

This adjustment doesn't change Task 3's commit; just the template detail.

- [ ] **Step 4: Verify the bundle builds with budget guard fires**

```bash
cd hugo-apps && npx vite build 2>&1 | tail -30
```

Expected: bundle builds successfully, see a line like:
```
[plugin validation-budget] validation.js: ~3000 bytes gzipped (budget 8192).
```

If the gzip size exceeds 8192, the build fails — investigate imports for size before continuing. Vue + the helper module + the small component should be ~3-4 KB gzipped (UI5 components are not bundled, they load globally via `ui5-bootstrap.ts`).

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/212-validation-modernisation" ] && \
  git add hugo-apps/src/validation/Validation.vue hugo-apps/src/validation/main.ts && \
  git commit -m "feat(212): Vue 3 island for [VALIDATE_N] questions (#212)

- Validation.vue: <script setup> Vue 3 SFC.
  Multiple-choice → <ui5-radio-button> per option.
  Text → <ui5-textarea>.
  Pass → <ui5-message-strip design='Positive'>.
  Fail → <ui5-message-strip design='Negative'> with Try Again button.
- main.ts: discovers .step-validation-mount elements, reads questions
  from #tutorial-data JSON, mounts one Vue app per step.
- localStorage persistence per (slug, stepNumber) so a learner who
  answered correctly doesn't get re-quizzed on reload.
- All-or-nothing grading per step (matches legacy behaviour).

Bundle: ~3 KB gzipped, well under 8 KB budget."
```

---

## Task 4: Hugo template wiring + delete legacy code

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`
- Modify: `hugo/assets/js/tutorial.ts` (DELETE lines 333-447 + the `initValidation()` call)

This is the cutover: the new island goes live, legacy code goes away. After this commit the validation widget on every tutorial page is the new Vue island.

- [ ] **Step 1: Add the script tag to `u1-object-page.html`**

Find the existing `code-check.js` script tag (around line 387). Read 5 lines above and 5 below for context. The existing block should look something like:

```html
{{ if and (not site.Params.qa) (not site.Params.previewMode) }}<script type="module" src="/js/code-check.js" defer></script>{{ end }}
```

Add a NEW line **adjacent** (immediately above or below), but with a **DIFFERENT guard** — `previewMode` only, NOT `qa AND previewMode`:

```html
{{ if not site.Params.previewMode }}<script type="module" src="/js/validation.js" defer></script>{{ end }}
```

The reason for the guard difference is documented in the spec's Hugo template change section: validation runs in QA mode (authors previewing their `[VALIDATE_N]` blocks need it), while code-check requires the QA exclusion because its endpoint may not be enabled on the QA srv (would 503 confusingly).

- [ ] **Step 2: Verify the Hugo build still works**

If you have Hugo installed locally, run a quick build to confirm no template errors:

```bash
hugo --source hugo --renderToMemory 2>&1 | tail -10
```

Expected: build completes. Look for "ERROR" or "Building sites" with no errors.

If Hugo isn't installed locally, skip this step — the layout is plain Go template syntax and will be exercised on first deploy.

- [ ] **Step 3: Read `hugo/assets/js/tutorial.ts` to find the legacy block**

```bash
grep -n "initValidation\|renderQuiz\|handleQuizSubmit\|interface ValidationQuestion\|interface StepData" hugo/assets/js/tutorial.ts
```

Should output line numbers around 333-447. Confirm those line ranges before deleting.

- [ ] **Step 4: Delete the legacy code**

In `hugo/assets/js/tutorial.ts`:

1. Delete lines 333-447 (the entire validation block: `// --- Validation quiz ---` comment through the end of `handleQuizSubmit`).
2. Find and delete the call to `initValidation()` (likely near line 500). Use `grep -n "initValidation" hugo/assets/js/tutorial.ts` after deleting the function to find the call site.
3. The `ValidationQuestion` and `StepData` interfaces (lines 333-345) are deleted with the block — they're not used anywhere else in `tutorial.ts`.

After deletion, confirm with:

```bash
grep -n "initValidation\|renderQuiz\|handleQuizSubmit\|interface ValidationQuestion\|interface StepData" hugo/assets/js/tutorial.ts
```

Expected: no matches. If anything remains, it wasn't fully deleted.

- [ ] **Step 5: Search for orphaned CSS classes**

The legacy markup used `.step-validation`, `.option-card`, `.validation-feedback`, `.validation-success`, `.validation-error`. Search for them:

```bash
grep -rn "\.step-validation\|\.option-card\|\.validation-feedback\|\.validation-success\|\.validation-error" hugo/assets/ hugo/static/ hugo/layouts/ 2>&1 | grep -v 'step-validation-mount'
```

Note the `grep -v 'step-validation-mount'` — that class is the mount div and is still in use, don't delete it.

For each match found, decide:
- If it's in a CSS file that's only used by the legacy widget → delete the rule.
- If it's used elsewhere (unlikely) → leave it.

Document any decisions inline in the commit message.

- [ ] **Step 6: Verify `tutorial.ts` still compiles**

```bash
cd d:/projects/tutorials-poc && npx tsc --noEmit hugo/assets/js/tutorial.ts 2>&1 | head -10
```

(Or whatever the project uses for TypeScript checking on Hugo assets.)

Expected: no errors. If TS reports unused imports after the deletion, remove them too.

- [ ] **Step 7: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/212-validation-modernisation" ] && \
  git add hugo/layouts/tutorials/u1-object-page.html hugo/assets/js/tutorial.ts <any-css-files-modified> && \
  git commit -m "feat(212): Hugo wiring + delete legacy validation code (#212)

- u1-object-page.html: load validation.js inside {{ if not previewMode }}
  block (NOT the qa+previewMode block — validation must run in QA so
  authors previewing their own [VALIDATE_N] blocks see them rendered).
- tutorial.ts: delete lines 333-447 (initValidation, renderQuiz,
  handleQuizSubmit, ValidationQuestion + StepData interfaces) and the
  call to initValidation() at line ~500.
- CSS: removed .step-validation, .option-card, .validation-feedback,
  .validation-success, .validation-error rules that only the legacy
  markup used.

After this commit, the validation widget on every tutorial page is
the new Vue island. .step-validation-mount divs stay; main.ts
attaches to them."
```

---

## Task 5: Developer documentation

**Files:**
- Create: `docs/developers/architecture/validation-widget.md`
- Modify: `docs/.vitepress/config.ts` (sidebar registration)

- [ ] **Step 1: Create the developer reference**

`docs/developers/architecture/validation-widget.md`:

```markdown
# Validation Widget

The `[VALIDATE_N]` validation widget renders quiz questions on tutorial steps.
Authors mark steps with `[VALIDATE_N]` blocks in their `rules.vr` files;
those parse into a per-step `validation` array on the Hugo frontmatter,
which the build serializes into the public `<script id="tutorial-data">`
JSON on each tutorial page. The Vue island reads from there.

## Architecture

- **Mount point:** `<div class="step-validation-mount" data-step="{N}">` in
  `hugo/layouts/shortcodes/tutorial-step.html` (line 17). Rendered for
  every step; the island's `main.ts` only mounts on steps where the
  parsed `validation` array is non-empty.
- **Bundle:** `hugo-apps/src/validation/` → `validation.js` (~3 KB gzipped,
  8 KB budget enforced by Vite plugin).
- **Loaded by:** `hugo/layouts/tutorials/u1-object-page.html` via
  `<script type="module" src="/js/validation.js" defer>` inside
  `{{ if not site.Params.previewMode }}` block. NOT the
  `qa AND previewMode` block — validation runs in QA mode so authors
  previewing their `[VALIDATE_N]` blocks see them rendered.

## Question types

- **Multiple-choice:** rendered as `<ui5-radio-button>` per option, scoped
  by question name. Exact-match grading.
- **Text:** rendered as `<ui5-textarea>`. Case-insensitive equality grading
  after trim.

Both types are graded **all-or-nothing per step**: ALL questions in a
step's `validation` array must be correct for the step to pass.

## Persistence

A learner who answers correctly is not re-quizzed on reload. The flag
lives in `localStorage` under key `tutorial-validation-${slug}-${stepNumber}`:

```json
{ "correct": true, "timestamp": 1717459200000 }
```

Only `correct: true` is persisted. Failed attempts don't get cached;
the learner can keep trying without state.

`readPersisted` and `writePersisted` are tolerant of localStorage
failures (private mode, quota exceeded) — both return null/silently
on error.

## Anti-leak: documented trade-off

The widget grades client-side, which means the `correctAnswer` field
ships in the public `<script id="tutorial-data">` JSON. This is a
known trade-off; it's been there since the rules.vr loader was written.

Server-side AI grading (issue #209) addresses this for any text question
the author marks with `###Grading: ai-judged`. Multiple-choice and plain
exact-match text questions stay client-side.

## Adding a new question type

To add (say) a "match this regex" question type:

1. Extend `ValidationQuestion` in `hugo-apps/src/validation/grading.ts`
   to include a new `type: 'regex'` case.
2. Update `gradeAnswers` to handle the new type. Add a unit test in
   `test/unit/validation-grading.test.js`.
3. Add a `<template v-else-if="q.type === 'regex'">` branch in
   `Validation.vue` rendering the appropriate input.
4. Update the parser at `scripts/parsers/rules.ts` to emit the new type.

For AI-graded variants, see issue #209's design at
`docs/superpowers/specs/2026-06-04-209-free-text-grader-design.md`.

## Reference

- Module: [`hugo-apps/src/validation/grading.ts`](../../../hugo-apps/src/validation/grading.ts)
- Component: [`hugo-apps/src/validation/Validation.vue`](../../../hugo-apps/src/validation/Validation.vue)
- Mount: [`hugo/layouts/shortcodes/tutorial-step.html:17`](../../../hugo/layouts/shortcodes/tutorial-step.html#L17)
- Spec: [`docs/superpowers/specs/2026-06-04-212-validation-widget-modernisation-design.md`](../../superpowers/specs/2026-06-04-212-validation-widget-modernisation-design.md)
- Tracking: [sap-tutorials/tutorials-ims#212](https://github.com/sap-tutorials/tutorials-ims/issues/212)
```

- [ ] **Step 2: Register in the VitePress sidebar**

In `docs/.vitepress/config.ts`, find the Architecture sidebar section (look for similar entries like `anonymization-cascade` or `code-check`). Add an entry pointing to `/developers/architecture/validation-widget`.

The exact format depends on the existing sidebar shape — read the file and follow the established pattern for the Architecture group.

- [ ] **Step 3: Verify docs build (sidebar guard passes)**

```bash
npm run docs:build 2>&1 | tail -10
```

Expected: build succeeds. Sidebar guard rejects unregistered pages or dead links — if it errors, the sidebar entry is in the wrong place or the file path is wrong.

- [ ] **Step 4: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/212-validation-modernisation" ] && \
  git add docs/developers/architecture/validation-widget.md docs/.vitepress/config.ts && \
  git commit -m "docs(212): validation widget developer reference (#212)

Covers architecture (mount point, bundle, loading guard rationale),
question types, localStorage persistence shape, the documented
client-side correctAnswer trade-off, and how to add a new question
type."
```

---

## Task 6: Final verification + draft PR

**Files:** none modified — verification only.

- [ ] **Step 1: Run unit tests**

```bash
npx vitest run test/unit/validation-grading.test.js
```

Expected: 15 passing.

- [ ] **Step 2: Verify the bundle builds and stays under budget**

```bash
cd hugo-apps && npx vite build 2>&1 | grep -E "validation|error|warn"
```

Expected:
- `validation.js: ~3000 bytes gzipped (budget 8192).` (warn-level, not an error)
- No errors

- [ ] **Step 3: Confirm the legacy code is gone**

```bash
grep -n "initValidation\|renderQuiz\|handleQuizSubmit\|interface ValidationQuestion" hugo/assets/js/tutorial.ts
```

Expected: no matches.

- [ ] **Step 4: Verify the script tag is in place with the correct guard**

```bash
grep -A1 "validation.js" hugo/layouts/tutorials/u1-object-page.html
```

Expected: line that matches `{{ if not site.Params.previewMode }}<script type="module" src="/js/validation.js" defer></script>{{ end }}` (NO `qa` exclusion).

- [ ] **Step 5: Manual smoke against a tutorial with `[VALIDATE_N]` content**

If `npm run dev` works in this worktree (per memory, sometimes it doesn't on Windows fresh worktrees), do the smoke check. Otherwise, document that it'll be tested post-deploy via the smoke suite.

```bash
npm run fetch-tutorials  # uses cache, fast
npm run dev              # Hugo dev server on http://localhost:1313
```

Open http://localhost:1313/tutorials/<slug-with-validation>/ in a browser. Verify:

- ✅ Multiple-choice questions render with `<ui5-radio-button>` styled options.
- ✅ Text questions render with `<ui5-textarea>`.
- ✅ Submit button is `<ui5-button design="Emphasized">`.
- ✅ Correct answer → green message strip, form replaced with success state.
- ✅ Wrong answer → red message strip with "Try Again" button.
- ✅ Reload page after correct → success state appears immediately, form is gone.
- ✅ DevTools → Application → Local Storage → see `tutorial-validation-${slug}-${step}` key.

If smoke can't be run locally, add a note to the PR description that smoke verification is deferred to post-deploy.

- [ ] **Step 6: Push the feature branch and open a draft PR**

```bash
git push -u origin feature/212-validation-modernisation
```

Open a PR using the same shape as #221's body (linking the spec, listing tasks, listing acceptance-criteria checkboxes).

---

## Cross-cutting concerns

### Security

- The widget grades client-side. The `correctAnswer` is in the public `<script id="tutorial-data">` JSON. This is a documented trade-off, not a regression — it's been this way since the rules.vr loader was written. Anti-leak is #209's territory.

### CAP 10 readiness

Not applicable — no backend changes in this PR.

### srv-qa cp list

Not applicable — no `srv/lib/` files touched.

### Branch hygiene

Every commit guards `git branch --show-current` against `feature/212-validation-modernisation`.

### Test environment

`npm test` reliably hangs on fresh worktrees per project memory. Run targeted test files only: `npx vitest run test/unit/validation-grading.test.js`.

---

## Final pre-flight checklist

- [ ] `hugo-apps/src/validation/{main.ts, Validation.vue, grading.ts}` shipped.
- [ ] Bundle: `validation.js` ≤ 8 KB gzipped, validated by `validationBudget()` plugin.
- [ ] `hugo/layouts/tutorials/u1-object-page.html` adds `<script type="module" src="/js/validation.js">` inside `{{ if not site.Params.previewMode }}` block (NOT qa+previewMode).
- [ ] `hugo/assets/js/tutorial.ts:333-447` deleted; `initValidation()` call removed.
- [ ] Legacy CSS classes removed if unused elsewhere.
- [ ] `<ui5-radio-button>` registered in `hugo/assets/js/ui5-bootstrap.ts`.
- [ ] All 15 unit tests pass.
- [ ] Manual smoke (or post-deploy verification noted in PR body).
- [ ] `docs/developers/architecture/validation-widget.md` shipped + sidebar registered.
- [ ] PR opened.
