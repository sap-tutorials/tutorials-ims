<script setup lang="ts">
defineProps<{
  xp: number;
  lessonId: string;
  lessonTitle: string;
  banterLine: string | null;
}>();

const emit = defineEmits<{
  (e: 'continue'): void;
  (e: 'back'): void;
}>();
</script>

<template>
  <div class="ktt-results" data-testid="ktt-results">
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
</style>
