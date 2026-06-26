<!-- hugo-apps/src/validation/Validation.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import PreviewAINotice from './PreviewAINotice.vue';
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
  // [#655] Preview-mode signals from main.ts (read from host data-attrs).
  // Defaults preserve prod behavior — absent in production tutorials.
  isPreview?: boolean;
  aiInvolved?: boolean;
  rulesBlockId?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isPreview: false,
  aiInvolved: false,
  rulesBlockId: undefined,
});

// [#655] In preview mode, when the step involves AI, we render the
// PreviewAINotice with the verbatim rules.vr block instead of the input
// form — the runtime AI behavior can only be exercised after a real publish.
const rulesBlockText = ref<string>('');

const answers = ref<Record<string, string>>({});
const submitted = ref(false);
const result = ref<'correct' | 'incorrect' | 'partial' | 'disabled' | null>(null);
const pending = ref(false);
const hint = ref('');

// Per-question verdict map populated by onSubmit. Each question's submission
// produces a verdict + optional hint; the template renders ✓ / ✗ / ⚠ next to
// each <fieldset> so the learner can see WHICH question(s) failed.
//
// Added 2026-06-23 — reported by Tom Jung: previously a single global "Not
// quite — give it another try" strip gave the learner no signal about which
// of N questions was wrong. With 2+ questions in a step the UX was opaque.
//
// Shape: { [questionId]: { verdict, hint?, summary? } }
//   verdict: 'pass'    — local-grade match or AI graded pass
//          | 'fail'    — local-grade mismatch or AI graded fail
//          | 'partial' — AI graded partial (always carries a hint per v2 prompt)
//          | 'error'   — AI graded but the call errored (rate-limit / network / 5xx)
//          | 'pending' — submitted but server response not yet received
//
// Local (non-AI) questions get pass/fail synchronously. AI questions cycle
// through 'pending' → terminal state. This lets the UI show a per-question
// spinner instead of the single overlay spinner that existed before.
type PerQuestionVerdict = 'pass' | 'fail' | 'partial' | 'error' | 'pending';
interface PerQuestionResult {
  verdict: PerQuestionVerdict;
  hint?: string;
  summary?: string;
  errorReason?: string;
}
const perQuestionResults = ref<Record<string, PerQuestionResult>>({});

// Abort controller for the in-flight AI-grading loop.
// Held at module scope (per Vue component instance) so a new submit can
// cancel the previous one's pending fetches. Today's Try-Again button is
// only rendered AFTER the loop completes (so this is theoretically
// unreachable), but a future refactor that exposes Try-Again mid-grade
// would expose a stale-result race without this guard. Belt-and-braces.
let inFlight: AbortController | null = null;

onMounted(() => {
  // [#655] Preview-mode: load the rules-vr-source <script> contents so
  // PreviewAINotice can show the verbatim block when "Reveal AI rules" is on.
  if (props.isPreview && props.rulesBlockId) {
    const scriptEl = document.getElementById(props.rulesBlockId) as HTMLScriptElement | null;
    if (scriptEl?.textContent) {
      try {
        rulesBlockText.value = JSON.parse(scriptEl.textContent);
      } catch {
        rulesBlockText.value = scriptEl.textContent;
      }
    }
  }
  // [#655] Preview-mode: listen for global reset event (from preview-banner).
  if (props.isPreview) {
    window.addEventListener('tutorial-preview:reset-answers', onPreviewReset);
  }

  // Prod-mode persistence rehydration. Skipped in preview — the preview
  // banner owns the reset semantics and persistence would only confuse the
  // author preview UX.
  if (props.isPreview) return;
  const persisted = readPersisted(props.slug, props.stepNumber);
  if (persisted?.correct) {
    submitted.value = true;
    result.value = 'correct';
    // Backfill perQuestionResults so the rendered ✓/✗ shows on persisted-correct
    // re-mount (e.g. learner returns to the tutorial after closing the tab).
    for (const q of props.questions) {
      perQuestionResults.value[q.id] = { verdict: 'pass' };
    }
    emitStepValidated();
  }
});

onUnmounted(() => {
  // Always remove — cheap, idempotent. We only added the listener in preview
  // mode, but removeEventListener on a never-attached handler is a no-op.
  window.removeEventListener('tutorial-preview:reset-answers', onPreviewReset);
});

function onPreviewReset(): void {
  // [#655] Clear in-memory state.
  answers.value = {};
  submitted.value = false;
  result.value = null;
  pending.value = false;
  hint.value = '';
  perQuestionResults.value = {};
  // Wipe persisted preview keys for this slug.
  if (typeof localStorage !== 'undefined') {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`tutorial-validation-${props.slug}-`)) {
        toRemove.push(key);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  }
}

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
 *   503        → ChatSettings.validateAnswerEnabled is false (graceful degradation)
 *   other 4xx/5xx → generic http_<status> error
 */
async function gradeAi(slug: string, stepNumber: number, questionId: string, submittedAnswer: string, signal?: AbortSignal) {
  // [#655] Preview never calls the AI grader — AI-involved questions render
  // as PreviewAINotice in the template, so this branch is only reached if
  // a preview tutorial happens to mix aiGrading questions without aiInvolved
  // set; defending here keeps the network surface zero in preview regardless.
  if (props.isPreview) {
    return { verdict: 'disabled' as const };
  }
  try {
    const res = await fetch('/api/validate-answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tutorialSlug: slug, stepNumber, questionId, submittedAnswer }),
      signal
    });
    if (res.status === 503) return { verdict: 'disabled' as const };
    if (res.status === 429) return { verdict: 'error' as const, errorReason: 'rate_limited' };
    if (!res.ok)            return { verdict: 'error' as const, errorReason: 'http_' + res.status };
    return await res.json();
  } catch (err) {
    // AbortError when the controller was aborted (a newer submit started or
    // the user clicked Try Again). Caller checks signal.aborted to decide
    // whether to ignore the result.
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { verdict: 'error' as const, errorReason: 'aborted' };
    }
    return { verdict: 'error' as const, errorReason: 'network' };
  }
}

async function onSubmit() {
  // Re-entry guard: defense-in-depth vs synthetic submits (devtools,
  // double-Enter on slow machine, screen reader replay). The :disabled
  // attribute on the submit button covers the common click path; this
  // guards everything else.
  if (pending.value) return;

  // Abort any in-flight grading from a prior submit. Today only matters
  // if a refactor exposes Try-Again mid-grade — current UI gates Try-Again
  // behind submitted+result so the loop has already exited. Belt-and-braces.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const { signal } = controller;

  submitted.value = true;
  pending.value = true;
  hint.value = '';
  // Reset per-question results for THIS submit. AI questions start in 'pending'
  // so the template can show a per-question spinner while the loop runs.
  perQuestionResults.value = {};
  try {
    const aiQs    = props.questions.filter(isAiGraded);
    const localQs = props.questions.filter(q => !isAiGraded(q));

    // Local synchronous grading first (cheap, fail-fast). Populate per-question
    // results for both pass and fail — the learner needs to see WHICH local
    // question(s) failed even if the AI questions will also be graded below.
    const local = gradeAnswers(localQs, answers.value);
    for (const r of local.perQuestion) {
      perQuestionResults.value[r.id] = { verdict: r.correct ? 'pass' : 'fail' };
    }

    // Short-circuit AI grading if ANY local question failed — saves token budget
    // and protects the per-(user, slug, step) rate limit. Per-question results
    // for AI questions stay un-set in this branch; the UI shows them as
    // "not yet graded" (no badge) so the learner can see they weren't graded.
    if (!local.correct) {
      result.value = 'incorrect';
      return;
    }

    // Initialise AI questions as 'pending' so the per-question template can
    // show a per-Q spinner. Each iteration of the loop replaces this with the
    // terminal verdict (pass/fail/partial/error).
    for (const q of aiQs) {
      perQuestionResults.value[q.id] = { verdict: 'pending' };
    }

    // Grade EVERY AI question serially — do NOT break on first failure.
    // (Pre-v2 code had `break` after first non-pass which hid per-question
    // feedback; Tom's 2026-06-23 report flagged this as the root UX bug.)
    // Serial (not Promise.all):
    //   1. Per-step rate limit caps at 5/5min, so a 5-Q parallel submit
    //      could exhaust the cap on a single click.
    //   2. Sequential gives more predictable UX (per-Q spinner ticks in order).
    let sawDisabled = false;
    for (const q of aiQs) {
      // If a newer submit started (or Try-Again was clicked), abandon this
      // loop without touching `result.value` — the new submit will write it.
      if (signal.aborted) return;
      const submittedAnswer = (answers.value[q.id] ?? '').trim();
      if (!submittedAnswer) {
        perQuestionResults.value[q.id] = {
          verdict: 'fail',
          summary: 'No answer provided',
          hint: 'Type an answer in the box and submit again.'
        };
        continue;
      }
      const r = await gradeAi(props.slug, props.stepNumber, q.id, submittedAnswer, signal);
      // Re-check after the await: the controller may have been aborted while
      // the fetch was in flight. Drop the response — never mutate state on
      // behalf of a stale submit.
      if (signal.aborted) return;

      // Disabled = operator turned off the AI grader (ChatSettings flag).
      // Surface as a separate UX state — break only because every subsequent
      // AI question would also be disabled and we don't want to waste calls.
      if (r.verdict === 'disabled') { sawDisabled = true; break; }

      // Normal pass/partial/fail/error — record per-question, continue the loop.
      perQuestionResults.value[q.id] = {
        verdict: r.verdict,
        hint: r.hint || '',
        summary: r.summary || '',
        errorReason: r.errorReason
      };
    }

    // Disabled short-circuits BEFORE the standard 3-state branching:
    // don't writePersisted (success not earned), don't fire step-validated,
    // don't surface a hint. The Information strip + Try Again button below
    // gives the learner a path forward without lying about correctness.
    if (sawDisabled) {
      result.value = 'disabled';
      return;
    }

    // Aggregate verdict from per-question results. The aggregate is used by
    // the existing top-of-form message strip; per-question badges below give
    // the granular breakdown.
    const verdicts = Object.values(perQuestionResults.value).map(r => r.verdict);
    const allPass = verdicts.every(v => v === 'pass');
    const anyPartial = verdicts.some(v => v === 'partial');
    // First hint from any failing question (partial or fail with hint). This
    // surfaces in the friendlier 'partial' Information strip so the learner
    // sees ONE clear "what to do next" callout. Per-Q hints in the badge
    // strips below give the granular breakdown.
    const firstHint = aiQs
      .map(q => perQuestionResults.value[q.id])
      .find(r => r && (r.verdict === 'partial' || r.verdict === 'fail') && r.hint)?.hint || '';

    if (allPass) {
      result.value = 'correct';
      hint.value = '';
      writePersisted(props.slug, props.stepNumber, true);
      emitStepValidated();
    } else if (anyPartial && firstHint) {
      // Any partial → step is 'partial' so the learner sees the hint banner.
      // Per-question badges still show fail for any non-partial mistakes.
      result.value = 'partial';
      hint.value = firstHint;
    } else if (firstHint) {
      // No partial, but at least one fail with a hint (v2 prompt provides
      // these). Use the 'partial' result-state so the hint surfaces in a
      // friendlier Information strip rather than the bare Negative "Not
      // quite" strip with no path forward.
      result.value = 'partial';
      hint.value = firstHint;
    } else {
      // No hint available — fall through to the standard incorrect state.
      result.value = 'incorrect';
    }
  } finally {
    // Clear pending only if THIS submit's controller is still the active one;
    // if a newer submit replaced it (signal.aborted), let the newer one own
    // the lifecycle. Same for inFlight.
    if (inFlight === controller) {
      inFlight = null;
      pending.value = false;
    }
  }
}

function onTryAgain() {
  // Cancel any in-flight grading (defensive — currently only fires if the
  // try-again button is clicked while pending=true, which the :disabled
  // attribute prevents on the click path but not via keyboard or programmatic).
  inFlight?.abort();
  inFlight = null;
  pending.value = false;
  // Allow re-submit on incorrect/partial: clear submitted state, keep answers
  // so the learner can adjust without re-typing. The form re-renders below.
  submitted.value = false;
  result.value = null;
  hint.value = '';
  // Clear per-question results too — the new submit will repopulate them.
  perQuestionResults.value = {};
}

// [#235] Expose internals for component-level tests in Validation.test.ts.
// Production callers don't reach into the component instance — these refs +
// methods are normally only manipulated through the template. Keeping the
// expose explicit (rather than turning off `<script setup>`'s default
// privacy) makes it clear what the tests rely on.
//
// Note: Vue auto-unwraps refs when accessed through the public proxy. So
// `wrapper.vm.result` is `string | null` (not `Ref<string | null>`).
// Tests that need to write to refs must use the exposed setters below
// rather than `wrapper.vm.answers = {...}` (which would replace the proxy
// property, not the underlying ref).
function _testSetAnswers(next: Record<string, string>) {
  answers.value = { ...next };
}

function _testSetPending(next: boolean) {
  pending.value = next;
}

defineExpose({
  // Reactive state (auto-unwrapped on read via vm proxy)
  result,
  pending,
  hint,
  submitted,
  perQuestionResults,
  // `answers` exposed read-only for tests so they can verify the typed
  // answer survives the lock (the template's :value bind on the textarea
  // is the user-visible side).
  answers,
  // Methods
  onSubmit,
  onTryAgain,
  // Test setter — preserves reactivity that direct vm.answers = ... would lose
  _testSetAnswers,
  _testSetPending,
});
</script>

<template>
  <div class="validation-widget">
    <!-- [#655] Preview-mode AI takeover: when this step is flagged as
         AI-involved by Task 5's data-attrs (free-text grading, AI-authored
         quiz, code-check, Joule step help), the runtime AI behavior is not
         reachable from Hugo dev mode. Render the PreviewAINotice with the
         verbatim rules.vr block instead of the question form — the form
         and its inputs are entirely skipped to make the limitation
         unmistakable. The "Reveal AI rules" toggle in the preview banner
         expands the <pre> inside the notice. -->
    <PreviewAINotice
      v-if="props.isPreview && props.aiInvolved"
      :rules-block="rulesBlockText"
    />

    <template v-else>
    <!-- Persisted-success state: show success banner AND keep the form
         mounted below in read-only mode, so the learner can re-read their
         answer (Tom's UX feedback 2026-06-24 — hiding the answer entirely
         on correct lost context the learner might want again). The form's
         inputs are bound `disabled` when result === 'correct' (see
         textarea / radio below) and the Submit button is hidden — there's
         nothing to re-submit once the step is locked in. -->
    <ui5-message-strip
      v-if="submitted && result === 'correct'"
      design="Positive"
      hide-close-button
    >
      Correct! Well done.
    </ui5-message-strip>

    <!-- Form: always mounted; disabled state controlled per-input by
         `result === 'correct'`. NOT @submit.prevent-suppressed on correct
         because the Submit button is conditionally rendered (and pressing
         Enter inside a disabled textarea is a no-op anyway). -->
    <form @submit.prevent="onSubmit">
      <fieldset
        v-for="(q, qi) in questions"
        :key="q.id"
        class="validation-question"
        :class="{
          'validation-question--pass': perQuestionResults[q.id]?.verdict === 'pass',
          'validation-question--fail': perQuestionResults[q.id]?.verdict === 'fail',
          'validation-question--partial': perQuestionResults[q.id]?.verdict === 'partial',
          'validation-question--pending': perQuestionResults[q.id]?.verdict === 'pending',
          'validation-question--error': perQuestionResults[q.id]?.verdict === 'error',
        }"
      >
        <legend class="validation-question__legend">
          <!-- Per-question verdict badge. Each badge has an aria-label so screen
               readers announce the verdict state without leaning on color alone. -->
          <span
            v-if="perQuestionResults[q.id]"
            class="validation-question__badge"
            :class="`validation-question__badge--${perQuestionResults[q.id].verdict}`"
            :aria-label="`Question ${qi + 1} verdict: ${perQuestionResults[q.id].verdict}`"
          >
            <template v-if="perQuestionResults[q.id].verdict === 'pass'">✓</template>
            <template v-else-if="perQuestionResults[q.id].verdict === 'fail'">✗</template>
            <template v-else-if="perQuestionResults[q.id].verdict === 'partial'">⚠</template>
            <template v-else-if="perQuestionResults[q.id].verdict === 'pending'">…</template>
            <template v-else-if="perQuestionResults[q.id].verdict === 'error'">!</template>
          </span>
          {{ q.question }}
        </legend>

        <template v-if="q.type === 'multiple-choice' && q.options">
          <div v-for="opt in q.options" :key="opt" class="option-row">
            <!-- Conditional disabled via v-bind because UI5 web components
                 treat attribute *presence* as truthy regardless of value
                 (disabled="false" still disables). See
                 docs/developers/reference/vue-islands-gotchas.md § UI5
                 boolean attr coercion. Same pattern as the Submit button
                 and the textarea below. -->
            <ui5-radio-button
              :name="`q-${stepNumber}-${qi}`"
              :value="opt"
              :text="opt"
              :checked="answers[q.id] === opt"
              v-bind="result === 'correct' ? { disabled: true } : {}"
              @change="onRadioChange(q.id, opt)"
            />
          </div>
        </template>

        <!-- :value binds the in-memory answer back into the textarea so
             that on the locked read-only state the learner sees what they
             wrote. v-bind={disabled: true} on correct locks edits; the
             input handler stays mounted so re-grading flows (partial /
             incorrect / error) can keep accepting input. -->
        <ui5-textarea
          v-else
          placeholder="Type your answer…"
          :rows="2"
          :value="answers[q.id] || ''"
          v-bind="result === 'correct' ? { disabled: true } : {}"
          @input="onTextInput(q.id, $event)"
        />

        <!-- Per-question hint: only shown when this question's verdict is
             partial OR fail AND a hint is present. Auto-escaped via Vue
             text interpolation — never v-html (server-side redactor catches
             reference-answer leakage; auto-escape is the second line of defence
             against attacker-controlled HTML from the model output). -->
        <div
          v-if="perQuestionResults[q.id]?.hint"
          class="validation-question__hint"
          :class="`validation-question__hint--${perQuestionResults[q.id].verdict}`"
        >
          <strong>Hint:</strong> {{ perQuestionResults[q.id].hint }}
        </div>

        <!-- Per-question error: rate-limit / network / 5xx. Surface so the
             learner knows the failure was infrastructure, not their answer. -->
        <div
          v-else-if="perQuestionResults[q.id]?.verdict === 'error'"
          class="validation-question__error"
        >
          <strong>Couldn't check this question.</strong>
          <template v-if="perQuestionResults[q.id].errorReason === 'rate_limited'">
            You've checked answers too many times — please wait a few minutes.
          </template>
          <template v-else-if="perQuestionResults[q.id].errorReason === 'network'">
            Network error — check your connection and try again.
          </template>
          <template v-else>
            Try again in a moment.
          </template>
        </div>
      </fieldset>

      <!-- Submit + busy indicator: hidden once result === 'correct'. The
           submission is locked in (writePersisted fired on the all-pass
           branch) — there's nothing left to re-submit, and showing a
           disabled Submit button just adds noise to a happy-path view.
           Partial / incorrect / disabled / error states keep the button
           visible (those branches use the surrounding result-specific
           strips below to drive Try Again instead of Submit). -->
      <div v-if="result !== 'correct'" class="validation-actions">
        <ui5-button design="Emphasized" type="Submit" v-bind="pending ? { disabled: true } : {}">
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

      <!-- Aggregate-Partial state: at least one Q is partial OR fail-with-hint.
           v2 prompt now provides hints on fail too, so this strip fires in
           more cases than v1 — the bare Negative "Not quite" strip below
           is only used when no question came back with any hint at all. -->
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
          v-bind="pending ? { disabled: true } : {}"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>

      <!-- Disabled state: AI grader is feature-flagged off (503 from
           /api/validate-answer when ChatSettings.validateAnswerEnabled=false).
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
          v-bind="pending ? { disabled: true } : {}"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>

      <!-- Incorrect-state strip + Try Again button.
           ui5-message-strip has no 'action' slot (verified via UI5 MCP),
           so the strip and button are rendered as siblings. With v2's
           always-provide-a-hint prompt, this strip is only reached when NO
           question came back with a hint — so the message stays bare "Not
           quite". When hints DO come back (the common case post-v2),
           result='partial' instead and the friendlier strip above fires. -->
      <template v-if="submitted && result === 'incorrect'">
        <ui5-message-strip design="Negative" hide-close-button>
          Not quite — give it another try.
        </ui5-message-strip>
        <ui5-button
          design="Default"
          @click="onTryAgain"
          v-bind="pending ? { disabled: true } : {}"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>
    </form>
    </template>
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
  /* Smooth color transition when verdicts arrive after the await */
  transition: border-color 0.2s ease, background-color 0.2s ease;
}
/* Per-question color cues. Border uses Horizon's semantic colors when
   available; the fallback hex matches the design system's tinted backgrounds. */
.validation-question--pass {
  border-color: var(--sapPositiveColor, #36a41d);
  background-color: var(--sapPositiveBackground, rgba(54, 164, 29, 0.04));
}
.validation-question--fail {
  border-color: var(--sapNegativeColor, #ee3939);
  background-color: var(--sapNegativeBackground, rgba(238, 57, 57, 0.04));
}
.validation-question--partial {
  border-color: var(--sapCriticalColor, #e76500);
  background-color: var(--sapCriticalBackground, rgba(231, 101, 0, 0.04));
}
.validation-question--pending {
  border-color: var(--sapInformativeColor, #0070f2);
  background-color: var(--sapInformativeBackground, rgba(0, 112, 242, 0.04));
}
.validation-question--error {
  border-color: var(--sapNeutralColor, #788fa6);
  background-color: var(--sapNeutralBackground, rgba(120, 143, 166, 0.04));
}
.validation-question__legend {
  font-weight: 600;
  padding: 0 0.5rem;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
/* Per-question badge — color-coded inline marker next to each question. */
.validation-question__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1;
}
.validation-question__badge--pass {
  background-color: var(--sapPositiveColor, #36a41d);
  color: white;
}
.validation-question__badge--fail {
  background-color: var(--sapNegativeColor, #ee3939);
  color: white;
}
.validation-question__badge--partial {
  background-color: var(--sapCriticalColor, #e76500);
  color: white;
}
.validation-question__badge--pending {
  background-color: var(--sapInformativeColor, #0070f2);
  color: white;
}
.validation-question__badge--error {
  background-color: var(--sapNeutralColor, #788fa6);
  color: white;
}
.validation-question__hint {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  line-height: 1.4;
}
.validation-question__hint--partial {
  background-color: var(--sapCriticalBackground, rgba(231, 101, 0, 0.08));
  border-left: 3px solid var(--sapCriticalColor, #e76500);
}
.validation-question__hint--fail {
  background-color: var(--sapNegativeBackground, rgba(238, 57, 57, 0.08));
  border-left: 3px solid var(--sapNegativeColor, #ee3939);
}
.validation-question__error {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  background-color: var(--sapNeutralBackground, rgba(120, 143, 166, 0.08));
  border-left: 3px solid var(--sapNeutralColor, #788fa6);
  border-radius: 0.25rem;
  font-size: 0.875rem;
  line-height: 1.4;
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
