<!--
  U6: End-of-tutorial rating + optional comment.
  - One ui5-rating-indicator (1-5 stars) + textarea + submit.
  - Posts to /feedback/submit (existing endpoint), maps stars 1-5 to npsScore 0-10.
  - Other dimension fields stay null — power-user 6-dim form is still reachable from the share menu / Discussion CTA.
  - Per-slug localStorage flag prevents re-prompting after a successful submit.
-->
<template>
  <div v-if="state !== 'dismissed'" class="tr">
    <div v-if="state === 'success'" class="tr__success">
      <span class="tr__success-icon" aria-hidden="true">✓</span>
      <span>Thanks — feedback recorded.</span>
    </div>
    <template v-else>
      <h3 class="tr__title">How was this tutorial?</h3>
      <p class="tr__hint">Your rating helps the author improve this content.</p>
      <ui5-rating-indicator
        ref="ratingRef"
        :value="rating"
        accessible-name="Tutorial rating"
        @change="onChange"
      ></ui5-rating-indicator>
      <textarea
        v-model="comment"
        class="tr__comment"
        rows="3"
        maxlength="2000"
        placeholder="What worked? What didn't? (optional)"
        aria-label="Optional comment"
      ></textarea>
      <input
        v-model="honeypot"
        type="text"
        name="hp"
        tabindex="-1"
        autocomplete="off"
        aria-hidden="true"
        class="tr__hp"
      >
      <div class="tr__actions">
        <ui5-button
          design="Emphasized"
          :disabled="rating === 0 || state === 'submitting'"
          @click="onSubmit"
        >{{ state === 'submitting' ? 'Submitting…' : 'Submit feedback' }}</ui5-button>
        <span v-if="state === 'error'" class="tr__error">{{ error }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ slug: string }>()

type RatingScale = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null
interface FeedbackSubmission {
  tutorialSlug: string
  ratingUseCase: RatingScale
  ratingRelevance: RatingScale
  ratingDuration: RatingScale
  ratingStructure: RatingScale
  ratingInteresting: RatingScale
  ratingVisuals: RatingScale
  npsScore: RatingScale
  comment: string
  wasAuthenticated: boolean
  honeypot: string
}

const STORAGE_KEY = `tutorial-rating-${props.slug}`
const STAR_TO_NPS: Record<number, RatingScale> = { 1: 0, 2: 3, 3: 5, 4: 8, 5: 10 }

const rating = ref(0)
const comment = ref('')
const honeypot = ref('')
const state = ref<'idle' | 'submitting' | 'success' | 'error' | 'dismissed'>('idle')
const error = ref('')
const ratingRef = ref<HTMLElement | null>(null)
let wasAuthenticated = false

onMounted(async () => {
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'submitted') {
      state.value = 'dismissed'
      return
    }
  } catch { /* private mode — fall through and show */ }
  try {
    const r = await fetch('/auth/user', { credentials: 'include' })
    wasAuthenticated = r.ok
  } catch { /* anonymous */ }
})

function onChange(e: CustomEvent<{ value: number }>) {
  const v = e.detail?.value ?? (e.target as { value?: number } | null)?.value ?? 0
  rating.value = Math.max(0, Math.min(5, Math.round(v)))
}

async function onSubmit() {
  if (rating.value < 1) return
  state.value = 'submitting'
  const payload: FeedbackSubmission = {
    tutorialSlug: props.slug,
    ratingUseCase: null,
    ratingRelevance: null,
    ratingDuration: null,
    ratingStructure: null,
    ratingInteresting: null,
    ratingVisuals: null,
    npsScore: STAR_TO_NPS[rating.value] ?? null,
    comment: comment.value.trim(),
    wasAuthenticated,
    honeypot: honeypot.value,
  }
  try {
    const r = await fetch('/feedback/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${r.status}`)
    }
    state.value = 'success'
    try { localStorage.setItem(STORAGE_KEY, 'submitted') } catch { /* private mode */ }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Submission failed'
    state.value = 'error'
  }
}
</script>

<style scoped>
.tr {
  margin: 1rem 0 1.5rem;
  padding: 1.25rem 1.5rem;
  background: var(--sapList_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapList_BorderColor);
  border-radius: 0.5rem;
}
.tr__title {
  margin: 0 0 0.25rem;
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--sapTextColor);
}
.tr__hint {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor);
}
.tr__comment {
  display: block;
  width: 100%;
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: 0.9375rem;
  color: var(--sapField_TextColor, var(--sapTextColor));
  background: var(--sapField_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapField_BorderColor, var(--sapList_BorderColor));
  border-radius: 0.25rem;
  resize: vertical;
  box-sizing: border-box;
}
.tr__comment:focus {
  outline: none;
  border-color: var(--sapField_Focus_BorderColor, var(--sapBrandColor, #0070f2));
  box-shadow: 0 0 0 1px var(--sapField_Focus_BorderColor, var(--sapBrandColor, #0070f2));
}
.tr__hp {
  position: absolute;
  left: -9999px;
}
.tr__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
.tr__error {
  font-size: 0.8125rem;
  color: var(--sapNegativeColor, #b00);
}
.tr__success {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9375rem;
  color: var(--sapPositiveColor, var(--sapTextColor));
}
.tr__success-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  background: var(--sapPositiveColor, #2b7c2b);
  color: var(--sapButton_Emphasized_TextColor, #fff);
  font-size: 0.8125rem;
  font-weight: 700;
}
</style>
