<!-- hugo-apps/src/validation/Validation.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  gradeAnswers,
  isAiGraded,
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
const result = ref<'correct' | 'incorrect' | 'partial' | 'disabled' | null>(null);
const pending = ref(false);
const hint = ref('');

onMounted(() => {
  const persisted = readPersisted(props.slug, props.stepNumber);
  if (persisted?.correct) {
    submitted.value = true;
    result.value = 'correct';
    emitStepValidated();
  }
});

function emitStepValidated() {
  // Notify tutorial.ts that this step's validation passed.
  // Reuses the legacy contract: dispatch a 'step-validated' CustomEvent
  // on the document, with detail.stepNumber so listeners can route.
  document.dispatchEvent(new CustomEvent('step-validated', {
    detail: { stepNumber: props.stepNumber }
  }));

  // Also set the data-validated attribute on the step container —
  // legacy tutorial.ts:440-442 did this, and other CSS/JS may key off it.
  const stepEl = document.querySelector(`.tutorial-step[data-step="${props.stepNumber}"]`);
  if (stepEl) stepEl.setAttribute('data-validated', 'true');
}

function onRadioChange(qid: string, value: string) {
  answers.value[qid] = value;
}

function onTextInput(qid: string, event: Event) {
  const ce = event as CustomEvent<{ value?: string }>;
  answers.value[qid] = ce.detail?.value ?? (event.target as { value?: string } | null)?.value ?? '';
}

/**
 * POST one AI-graded answer to /api/validate-answer.
 * Maps non-2xx + network failures to discrete verdict shapes the caller
 * pattern-matches on. The endpoint contract is documented in the plan:
 *   200 OK     → { verdict, summary?, hint?, errorReason? }
 *   429        → rate limited (per-user 30/hr OR per-step 5/5min)
 *   503        → ChatSettings.codeCheckEnabled is false (graceful degradation)
 *   other 4xx/5xx → generic http_<status> error
 */
async function gradeAi(slug: string, stepNumber: number, questionId: string, submittedAnswer: string) {
  try {
    const res = await fetch('/api/validate-answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tutorialSlug: slug, stepNumber, questionId, submittedAnswer })
    });
    if (res.status === 503) return { verdict: 'disabled' as const };
    if (res.status === 429) return { verdict: 'error' as const, errorReason: 'rate_limited' };
    if (!res.ok)            return { verdict: 'error' as const, errorReason: 'http_' + res.status };
    return await res.json();
  } catch {
    return { verdict: 'error' as const, errorReason: 'network' };
  }
}

async function onSubmit() {
  // Re-entry guard: defense-in-depth vs synthetic submits (devtools,
  // double-Enter on slow machine, screen reader replay). The :disabled
  // attribute on the submit button covers the common click path; this
  // guards everything else.
  if (pending.value) return;

  submitted.value = true;
  pending.value = true;
  hint.value = '';
  try {
    const aiQs    = props.questions.filter(isAiGraded);
    const localQs = props.questions.filter(q => !isAiGraded(q));

    // Local synchronous grading first (cheap, fail-fast). If any non-AI
    // question is wrong, short-circuit before spending a single LLM call —
    // saves token budget and protects the per-(user, slug, step) rate limit.
    const local = gradeAnswers(localQs, answers.value);
    if (!local.correct) {
      result.value = 'incorrect';
      return;
    }

    // All local Qs pass — grade AI Qs serially. Serial (not Promise.all):
    //   1. Per-step rate limit caps at 5/5min, so a 5-Q parallel submit
    //      could exhaust the cap on a single click.
    //   2. Sequential gives more predictable UX (busy spinner ticks per Q).
    let allPass = true;
    let firstHint = '';
    let sawDisabled = false;
    for (const q of aiQs) {
      const submittedAnswer = (answers.value[q.id] ?? '').trim();
      if (!submittedAnswer) { allPass = false; break; }
      const r = await gradeAi(props.slug, props.stepNumber, q.id, submittedAnswer);
      if (r.verdict === 'pass') continue;
      allPass = false;
      // Disabled = operator turned off the AI grader (ChatSettings flag);
      // surface as a separate UX state — see the disabled message-strip
      // below. Punishing the learner with 'incorrect' for an operator
      // decision would be dishonest.
      if (r.verdict === 'disabled') { sawDisabled = true; break; }
      // Partial only counts when the model returned a non-empty hint —
      // otherwise we fall through to the standard incorrect state.
      if (r.verdict === 'partial' && r.hint && !firstHint) firstHint = r.hint;
      // 'fail' / 'error' / partial-without-hint:
      // short-circuit — no further AI calls, no follow-on hints surfaced.
      break;
    }

    // Disabled short-circuits BEFORE the standard 3-state branching:
    // don't writePersisted (success not earned), don't fire step-validated,
    // don't surface a hint. The Information strip + Try Again button below
    // gives the learner a path forward without lying about correctness.
    if (sawDisabled) {
      result.value = 'disabled';
      return;
    }

    if (allPass) {
      result.value = 'correct';
      hint.value = '';
      writePersisted(props.slug, props.stepNumber, true);
      emitStepValidated();
    } else if (firstHint) {
      result.value = 'partial';
      hint.value = firstHint;
    } else {
      result.value = 'incorrect';
    }
  } finally {
    pending.value = false;
  }
}

function onTryAgain() {
  // Allow re-submit on incorrect/partial: clear submitted state, keep answers
  // so the learner can adjust without re-typing. The form re-renders below.
  submitted.value = false;
  result.value = null;
  hint.value = '';
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
        <ui5-button design="Emphasized" type="Submit" :disabled="pending">
          Submit Answer
        </ui5-button>
        <!-- Async grading overlay. delay=0 so the spinner appears instantly
             on click. Active is bound to the same `pending` flag that
             disables the button (prevents double-click duplicate POSTs). -->
        <ui5-busy-indicator
          v-if="pending"
          delay="0"
          active
          size="Small"
          class="validation-busy"
        />
      </div>

      <!-- Partial state: model-authored hint, NOT canned text. Only shown
           when the AI grader returned verdict=partial AND a non-empty hint;
           a partial-without-hint falls through to the incorrect state. -->
      <template v-if="submitted && result === 'partial'">
        <ui5-message-strip design="Information" hide-close-button>
          <!-- {{ hint }} is auto-escaped by Vue. NEVER switch to v-html —
               model output is supposed to be hint text only (Task 4
               reference-answer redactor catches reference-answer leakage),
               but if the redactor ever misses, attacker-controlled HTML
               from the model output would render unsanitized. Auto-escape
               is the second line of defence. -->
          {{ hint }}
        </ui5-message-strip>
        <ui5-button
          design="Default"
          @click="onTryAgain"
          :disabled="pending"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>

      <!-- Disabled state: AI grader is feature-flagged off (503 from
           /api/validate-answer when ChatSettings.codeCheckEnabled=false).
           This is a 4th UX state distinct from incorrect — Task 2's
           anti-leak strip removed `correctAnswer` from the public payload
           for AI questions, so we can't fall back to client-side equality
           grading. Telling the learner "wrong" when the system is off
           would punish them for an operator decision. -->
      <template v-if="submitted && result === 'disabled'">
        <ui5-message-strip design="Information" hide-close-button>
          Answer checking is temporarily unavailable. Please try again later.
        </ui5-message-strip>
        <ui5-button
          design="Default"
          @click="onTryAgain"
          :disabled="pending"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>

      <!-- Incorrect-state strip + Try Again button.
           ui5-message-strip has no 'action' slot (verified via UI5 MCP),
           so the strip and button are rendered as siblings. -->
      <template v-if="submitted && result === 'incorrect'">
        <ui5-message-strip design="Negative" hide-close-button>
          Not quite — give it another try.
        </ui5-message-strip>
        <ui5-button
          design="Default"
          @click="onTryAgain"
          :disabled="pending"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>
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
  align-items: center;
  gap: 0.5rem;
}
.validation-busy {
  /* Inline next to the disabled submit button while async AI grading runs. */
  display: inline-block;
}
</style>
