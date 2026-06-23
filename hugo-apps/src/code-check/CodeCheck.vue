<!--
  Code-check island: paste box + structured pass/partial/fail verdict UI.
  Lazily mounted on .step-codecheck-mount when present on a tutorial page.
  POSTs to /api/codecheck; handles 200/400/401/429/500/503.
  Ask-Joule handoff uses window.joule.openWithMessage (joule.js global).
-->
<template>
  <div class="cc">
    <!-- Unauthenticated: hide textarea, show sign-in prompt -->
    <template v-if="error === 'unauthenticated'">
      <p class="cc__goal">{{ goal }}</p>
      <ui5-message-strip design="Warning" hide-close-button>
        Sign in to check your code.
        <a href="/login" class="cc__login-link">Sign in</a>
      </ui5-message-strip>
    </template>

    <!-- Normal flow -->
    <template v-else>
      <p v-if="goal" class="cc__goal">{{ goal }}</p>

      <ul v-if="hints.length > 0" class="cc__hints">
        <li v-for="h in hints" :key="h">{{ h }}</li>
      </ul>

      <textarea
        ref="textareaRef"
        v-model="code"
        class="cc__textarea"
        :disabled="submitting"
        rows="10"
        style="font-family: monospace; width: 100%; box-sizing: border-box;"
        placeholder="Paste your code here…"
        aria-label="Code to check"
      ></textarea>

      <!-- Error strips (non-unauthenticated errors) -->
      <ui5-message-strip
        v-if="error === 'rate_limited'"
        design="Warning"
        class="cc__strip"
        hide-close-button
      >You have used your hourly checks. Try again in {{ Math.ceil(retryAfter / 60) }} min.</ui5-message-strip>

      <ui5-message-strip
        v-else-if="error === 'too_long'"
        design="Warning"
        class="cc__strip"
        hide-close-button
      >Code is too long; please trim to approximately 500 lines.</ui5-message-strip>

      <ui5-message-strip
        v-else-if="error === 'disabled'"
        design="Warning"
        class="cc__strip"
        hide-close-button
      >Code-check is currently disabled.</ui5-message-strip>

      <ui5-message-strip
        v-else-if="error === 'internal'"
        design="Negative"
        class="cc__strip"
        hide-close-button
      >We hit an internal error. Please try again.</ui5-message-strip>

      <!-- Busy indicator while submitting -->
      <ui5-busy-indicator v-if="submitting" active class="cc__busy"></ui5-busy-indicator>

      <!-- Verdict section -->
      <template v-if="verdict">
        <ui5-message-strip
          :design="stripDesign(verdict.verdict)"
          class="cc__strip"
          hide-close-button
        >{{ verdict.summary }}</ui5-message-strip>

        <template v-if="verdict.correctAspects && verdict.correctAspects.length > 0">
          <p class="cc__section-title">What you got right</p>
          <ul class="cc__list">
            <li v-for="item in verdict.correctAspects" :key="item">{{ item }}</li>
          </ul>
        </template>

        <template v-if="verdict.suggestions && verdict.suggestions.length > 0">
          <p class="cc__section-title">Suggestions</p>
          <ul class="cc__list">
            <li v-for="item in verdict.suggestions" :key="item">{{ item }}</li>
          </ul>
        </template>

        <div class="cc__actions">
          <ui5-button design="Default" @click="reset">Try again</ui5-button>
          <ui5-button
            v-if="jouleAvailable"
            design="Transparent"
            @click="askJoule"
          >Ask Joule about this</ui5-button>
        </div>
      </template>

      <!-- Submit button (shown when no verdict yet) -->
      <div v-else class="cc__actions">
        <ui5-button
          design="Emphasized"
          :disabled="submitting || !code.trim()"
          @click="submit"
        >Check my code</ui5-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

const props = defineProps<{
  slug: string
  stepNumber: number
  goal: string
  language: string
  hints: string[]
  hasReference: boolean
}>()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VerdictShape {
  verdict: 'pass' | 'partial' | 'fail'
  summary: string
  suggestions: string[]
  correctAspects: string[]
}

type ErrorCode = 'rate_limited' | 'unauthenticated' | 'disabled' | 'too_long' | 'internal' | null

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const code = ref('')
const verdict = ref<VerdictShape | null>(null)
const error = ref<ErrorCode>(null)
const submitting = ref(false)
const retryAfter = ref(0)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const jouleAvailable = computed(() =>
  typeof window !== 'undefined' &&
  typeof (window as any).joule?.openWithMessage === 'function'
)

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function stripDesign(v: 'pass' | 'partial' | 'fail'): string {
  return v === 'pass' ? 'Positive' : v === 'partial' ? 'Warning' : 'Negative'
}

async function submit() {
  if (!code.value.trim() || submitting.value) return
  submitting.value = true
  verdict.value = null
  error.value = null
  try {
    const res = await fetch('/api/codecheck', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: props.slug,
        stepNumber: props.stepNumber,
        submittedCode: code.value,
        language: props.language,
      }),
    })

    if (res.ok) {
      // 200: structured verdict — but error-shaped bodies also arrive as 200
      // (e.g. { verdict: 'error', errorReason: 'spec_missing' }). Guard before
      // casting so we never render an empty strip with 'summary' undefined.
      const body = await res.json()
      if (!body || !['pass', 'partial', 'fail'].includes(body.verdict)) {
        // Server returned an error-shaped verdict (spec_missing, upstream, schema).
        // Map to the internal-error UI rather than rendering an empty strip.
        // (A backend fix returning 5xx instead would also work but reshapes
        // the Task 1.5/1.6 contracts — deferred to a future cleanup.)
        error.value = 'internal'
        return
      }
      verdict.value = body as VerdictShape
      error.value = null
      // Notify the page (tutorial.ts) so it can gate the step's Done button.
      // Hard gate (2026-06-23): the Done button on a code-check step is
      // disabled until the verdict is 'pass'. Per-step decision lives in
      // tutorial.ts; we just publish the verdict here.
      document.dispatchEvent(new CustomEvent('tutorial:codecheck-verdict', {
        detail: {
          slug: props.slug,
          stepNumber: props.stepNumber,
          verdict: body.verdict,
        },
      }))
    } else if (res.status === 401) {
      error.value = 'unauthenticated'
    } else if (res.status === 400) {
      const body = await res.json().catch(() => ({}))
      error.value = body.error === 'too_long' ? 'too_long' : 'internal'
    } else if (res.status === 429) {
      error.value = 'rate_limited'
      const header = res.headers.get('Retry-After')
      const n = parseInt(header ?? '', 10)
      retryAfter.value = Number.isFinite(n) && n > 0 ? n : 3600
    } else if (res.status === 503) {
      error.value = 'disabled'
    } else {
      error.value = 'internal'
    }
  } catch {
    error.value = 'internal'
  } finally {
    submitting.value = false
  }
}

function reset() {
  verdict.value = null
  error.value = null
  // code is intentionally kept so the learner can iterate
  nextTick(() => {
    textareaRef.value?.focus()
  })
}

function askJoule() {
  if (!verdict.value) return
  const text = `I submitted code for step ${props.stepNumber} of ${props.slug}. The grader said: ${verdict.value.summary}. Help me understand.`
  ;(window as any).joule?.openWithMessage({ text })
}
</script>

<style scoped>
.cc {
  margin: 1rem 0 1.5rem;
  padding: 1.25rem 1.5rem;
  background: var(--sapList_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapList_BorderColor);
  border-radius: 0.5rem;
}

.cc__goal {
  margin: 0 0 0.75rem;
  font-size: 0.9375rem;
  color: var(--sapTextColor);
}

.cc__hints {
  margin: 0 0 0.75rem;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor);
}

.cc__hints li {
  margin-bottom: 0.25rem;
}

.cc__textarea {
  display: block;
  width: 100%;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--sapField_TextColor, var(--sapTextColor));
  background: var(--sapField_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapField_BorderColor, var(--sapList_BorderColor));
  border-radius: 0.25rem;
  resize: vertical;
  box-sizing: border-box;
}

.cc__textarea:focus {
  outline: none;
  border-color: var(--sapField_Focus_BorderColor, var(--sapBrandColor, #0070f2));
  box-shadow: 0 0 0 1px var(--sapField_Focus_BorderColor, var(--sapBrandColor, #0070f2));
}

.cc__textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.cc__busy {
  display: block;
  margin: 0.5rem 0;
}

.cc__strip {
  display: block;
  margin: 0.75rem 0;
}

.cc__section-title {
  margin: 0.75rem 0 0.25rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--sapTextColor);
}

.cc__list {
  margin: 0 0 0.5rem;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  color: var(--sapTextColor);
}

.cc__list li {
  margin-bottom: 0.25rem;
}

.cc__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}

.cc__login-link {
  margin-left: 0.5rem;
  color: var(--sapLinkColor, var(--sapBrandColor, #0070f2));
}
</style>
