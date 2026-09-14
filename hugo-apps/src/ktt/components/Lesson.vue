<script setup lang="ts">
import { ref, computed } from 'vue';
import KasimirStage from './KasimirStage.vue';
import {
  createSession,
  currentBeat,
  answerDrill,
  advance,
  isComplete,
} from '../lib/engine';
import type { KttLesson, KttBeat, KttDrillBeat } from '../lib/engine';

// ---------------------------------------------------------------------------
// Props / emits
// ---------------------------------------------------------------------------
const props = defineProps<{ lesson: KttLesson }>();
const emit = defineEmits<{
  (e: 'complete', lessonId: string, xp: number): void;
  (e: 'back'): void;
}>();

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
const session = ref(createSession(props.lesson));

type Mood = 'idle' | 'teaching' | 'thinking' | 'correct' | 'wrong' | 'celebrate';
const mood = ref<Mood>('teaching');

// null = no feedback yet for this beat; 'correct'|'wrong' = just answered
const answerState = ref<'correct' | 'wrong' | null>(null);
const done = ref(false);

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------
const beat = computed<KttBeat | null>(() => currentBeat(session.value));

const drillChoices = computed<string[]>(() => {
  const b = beat.value;
  if (!b || b.type !== 'drill') return [];
  const d = b as KttDrillBeat;
  // Fisher-Yates shuffle so the correct answer isn't always last
  const arr = [...d.distractors, d.answer];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
});

// Kasimir speech line for the current beat / feedback
const speechLine = computed<string>(() => {
  const b = beat.value;
  if (done.value) return 'Amazing! Lesson complete!';
  if (!b) return '';
  if (answerState.value === 'correct') {
    return (b as KttDrillBeat).kasimirRight ?? 'Correct!';
  }
  if (answerState.value === 'wrong') {
    return (b as KttDrillBeat).kasimirWrong ?? 'Try again…';
  }
  if (b.type === 'story') return b.kasimir;
  return (b as KttDrillBeat).prompt;
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function handleNext() {
  answerState.value = null;
  advance(session.value);
  if (isComplete(session.value)) {
    done.value = true;
    mood.value = 'celebrate';
    emit('complete', props.lesson.id, session.value.xp);
    return;
  }
  const b = currentBeat(session.value);
  mood.value = b?.type === 'story' ? 'teaching' : 'thinking';
}

function handleChoice(choice: string) {
  const result = answerDrill(session.value, choice);
  if (result.correct) {
    answerState.value = 'correct';
    mood.value = 'correct';
  } else {
    answerState.value = 'wrong';
    mood.value = 'wrong';
  }
}
</script>

<template>
  <div class="ktt-lesson">
    <button
      v-if="!done"
      type="button"
      class="ktt-lesson__back"
      data-testid="ktt-lesson-back"
      @click="emit('back')"
    >← Back to map</button>

    <div class="ktt-lesson__stage">
      <KasimirStage :mood="mood" />
      <p class="ktt-lesson__speech" v-if="speechLine">{{ speechLine }}</p>
    </div>

    <div class="ktt-lesson__xp" v-if="session.xp > 0" data-testid="ktt-xp">
      +{{ session.xp }} XP
    </div>

    <!-- Complete state -->
    <div v-if="done" class="ktt-lesson__complete">
      <p>Lesson complete! You earned {{ session.xp }} XP.</p>
    </div>

    <!-- Story beat -->
    <div v-else-if="beat && beat.type === 'story'" class="ktt-lesson__story">
      <p>{{ beat.kasimir }}</p>
      <button data-testid="ktt-next" @click="handleNext">Next</button>
    </div>

    <!-- Drill beat — after correct/wrong answer, show Next -->
    <div v-else-if="beat && beat.type === 'drill'" class="ktt-lesson__drill">
      <p class="ktt-lesson__prompt">{{ (beat as any).prompt }}</p>

      <div v-if="answerState === null" class="ktt-lesson__choices">
        <button
          v-for="choice in drillChoices"
          :key="choice"
          data-testid="ktt-choice"
          class="ktt-choice"
          @click="handleChoice(choice)"
        >{{ choice }}</button>
      </div>

      <div v-else class="ktt-lesson__feedback">
        <p>{{ answerState === 'correct' ? (beat as any).kasimirRight : (beat as any).kasimirWrong }}</p>
        <button data-testid="ktt-next" @click="handleNext">
          {{ answerState === 'correct' ? 'Continue' : 'Got it — continue' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ktt-lesson {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  align-items: center;
  padding: 1.5rem;
  max-width: 600px;
  margin: 0 auto;
}

.ktt-lesson__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  width: 160px;
}

.ktt-lesson__speech {
  font-style: italic;
  text-align: center;
  font-size: 0.9rem;
  color: #555;
}

.ktt-lesson__xp {
  font-weight: bold;
  color: #28a745;
  font-size: 1.1rem;
}

.ktt-lesson__prompt {
  font-size: 1.1rem;
  font-weight: 600;
  text-align: center;
  margin-bottom: 0.75rem;
}

.ktt-lesson__choices {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}

.ktt-choice {
  padding: 0.75rem 1.25rem;
  border: 2px solid #0070f2;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 0.95rem;
  text-align: left;
  transition: background 0.15s;
}

.ktt-choice:hover {
  background: #e8f2ff;
}

.ktt-lesson__feedback {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: center;
}

button[data-testid="ktt-next"] {
  padding: 0.6rem 1.5rem;
  background: #0070f2;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.95rem;
}

button[data-testid="ktt-next"]:hover {
  background: #005bb5;
}

.ktt-lesson__back {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0.25rem 0;
  color: #0070f2;
  cursor: pointer;
  font-size: 0.9rem;
}

.ktt-lesson__back:hover {
  text-decoration: underline;
}

/* Dark mode — site toggles `html.dark`. White choice cards otherwise
   inherited white text (light-on-light, unreadable). */
html.dark .ktt-choice {
  background: #1c2733;
  border-color: #4db1ff;
  color: #e6edf3;
}

html.dark .ktt-choice:hover {
  background: #243447;
}

html.dark .ktt-lesson__speech {
  color: #aeb8c2;
}

html.dark .ktt-lesson__xp {
  color: #4ade80;
}

html.dark .ktt-lesson__back {
  color: #4db1ff;
}
</style>
