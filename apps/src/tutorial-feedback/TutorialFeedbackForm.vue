<template>
  <div v-if="state === 'idle' || state === 'submitting' || state === 'error'">
    <h3 class="popup-title">How was this tutorial?</h3>
    <form @submit.prevent="onSubmit">
      <div v-for="row in rows" :key="row.key" class="feedback-row">
        <label>{{ row.label }}</label>
        <div class="feedback-scale">
          <button v-for="n in 11" :key="n" type="button"
                  :class="{ selected: form[row.key] === n - 1 }"
                  @click="form[row.key] = n - 1">{{ n - 1 }}</button>
          <button type="button" :class="{ selected: form[row.key] === null }"
                  @click="form[row.key] = null">N/A</button>
        </div>
      </div>
      <label class="feedback-row">
        <span>Anything else?</span>
        <textarea v-model="form.comment" maxlength="2000" rows="3"></textarea>
      </label>
      <input v-model="form.honeypot" type="text" name="honeypot"
             tabindex="-1" autocomplete="off" aria-hidden="true"
             style="position:absolute;left:-9999px" />
      <div v-if="state === 'error'" class="feedback-error">{{ error }}</div>
      <button type="submit" :disabled="state === 'submitting'" class="feedback-btn">
        {{ state === 'submitting' ? 'Submitting…' : 'Submit' }}
      </button>
    </form>
  </div>
  <div v-else-if="state === 'success'" class="feedback-success">
    <h3 class="popup-title">Thanks for your feedback!</h3>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { probeAuth, submitFeedback } from './api';
import type { FeedbackSubmission } from './types';

const props = defineProps<{ slug: string; onClose: () => void }>();

const rows = [
  { key: 'ratingUseCase',     label: 'Helpful for my use case' },
  { key: 'ratingRelevance',   label: 'Relevant to my work' },
  { key: 'ratingDuration',    label: 'Right length' },
  { key: 'ratingStructure',   label: 'Well structured' },
  { key: 'ratingInteresting', label: 'Interesting' },
  { key: 'ratingVisuals',     label: 'Good visuals & code samples' },
  { key: 'npsScore',          label: 'Likely to recommend to a colleague' }
] as const;

const state = ref<'idle' | 'submitting' | 'success' | 'error'>('idle');
const error = ref('');
const form = reactive<FeedbackSubmission>({
  tutorialSlug: props.slug,
  ratingUseCase: null, ratingRelevance: null, ratingDuration: null,
  ratingStructure: null, ratingInteresting: null, ratingVisuals: null,
  npsScore: null, comment: '', wasAuthenticated: false, honeypot: ''
});

onMounted(async () => { form.wasAuthenticated = await probeAuth(); });

async function onSubmit() {
  state.value = 'submitting';
  try {
    await submitFeedback(form);
    state.value = 'success';
    setTimeout(() => props.onClose(), 2000);
  } catch (e: any) {
    error.value = e.message || 'Submission failed';
    state.value = 'error';
  }
}
</script>

<style scoped>
.feedback-row { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
.feedback-scale { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.feedback-scale button { min-width: 2rem; padding: 0.25rem; border: 1px solid var(--sapButton_BorderColor, #ccc); background: var(--sapButton_Background, #fff); cursor: pointer; }
.feedback-scale button.selected { background: var(--sapButton_Selected_Background, #0070f2); color: var(--sapButton_Selected_TextColor, #fff); }
.feedback-error { color: #b00; margin: 0.5rem 0; }
</style>
