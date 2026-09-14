<script setup lang="ts">
import { PASS_RATIO } from '../lib/engine';

const props = defineProps<{
  xp: number;
  lessonId: string;
  lessonTitle: string;
  banterLine: string | null;
  passed: boolean;
  correct: number;
  total: number;
}>();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'retry'): void;
  (e: 'back'): void;
}>();

const passPercent = Math.round(PASS_RATIO * 100);
</script>

<template>
  <!-- Passed: mastered -->
  <div v-if="passed" class="ktt-results" data-testid="ktt-results">
    <h2>Lesson Complete!</h2>
    <p class="ktt-results__lesson">{{ lessonTitle }}</p>

    <div class="ktt-results__xp" data-testid="ktt-results-xp">
      +{{ xp }} XP earned
    </div>

    <p v-if="banterLine" class="ktt-results__banter">
      {{ banterLine }}
    </p>

    <div class="ktt-results__actions">
      <button data-testid="ktt-results-continue" @click="emit('continue')">
        Keep Learning
      </button>
      <button data-testid="ktt-results-back" class="ktt-results__back" @click="emit('back')">
        Back to Map
      </button>
    </div>
  </div>

  <!-- Not passed: below the mastery threshold — no XP banked, offer a retry -->
  <div v-else class="ktt-results ktt-results--failed" data-testid="ktt-results-failed">
    <h2>Not quite yet</h2>
    <p class="ktt-results__lesson">{{ lessonTitle }}</p>

    <div class="ktt-results__score" data-testid="ktt-results-score">
      You got {{ correct }} of {{ total }} right — you need {{ passPercent }}% to master this lesson.
    </div>

    <p v-if="banterLine" class="ktt-results__banter">
      {{ banterLine }}
    </p>

    <div class="ktt-results__actions">
      <button data-testid="ktt-results-retry" @click="emit('retry')">
        Try Again
      </button>
      <button data-testid="ktt-results-back" class="ktt-results__back" @click="emit('back')">
        Back to Map
      </button>
    </div>
  </div>
</template>

<style scoped>
.ktt-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  padding: 2rem;
  text-align: center;
  max-width: 500px;
  margin: 0 auto;
}

.ktt-results__lesson {
  font-size: 1rem;
  color: #555;
}

.ktt-results__xp {
  font-size: 1.4rem;
  font-weight: bold;
  color: #28a745;
}

.ktt-results__score {
  font-size: 1.05rem;
  font-weight: 600;
  color: #b45309;
  max-width: 38ch;
}

.ktt-results__banter {
  font-style: italic;
  color: #444;
}

.ktt-results__actions {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  justify-content: center;
}

button {
  padding: 0.65rem 1.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.95rem;
  border: none;
  background: #0070f2;
  color: #fff;
  transition: background 0.15s;
}

button:hover {
  background: #005bb5;
}

.ktt-results__back {
  background: #e8e8e8;
  color: #333;
  border: 1px solid #bbb;
}

.ktt-results__back:hover {
  background: #d0d0d0;
}

/* Dark mode — site toggles `html.dark`. */
html.dark .ktt-results__lesson {
  color: #aeb8c2;
}

html.dark .ktt-results__xp {
  color: #4ade80;
}

html.dark .ktt-results__score {
  color: #fbbf24;
}

html.dark .ktt-results__banter {
  color: #c3ccd5;
}

html.dark .ktt-results__back {
  background: #2a3542;
  color: #e6edf3;
  border-color: #55606b;
}

html.dark .ktt-results__back:hover {
  background: #354354;
}
</style>
