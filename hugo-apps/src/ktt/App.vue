<script setup lang="ts">
import { ref, computed } from 'vue';
import KasimirStage from './components/KasimirStage.vue';
import SkillTreeMap from './components/SkillTreeMap.vue';
import Lesson from './components/Lesson.vue';
import Results from './components/Results.vue';
import { loadLocal, saveLocal, mergeProgress } from './lib/progress';
import { isAuthenticated, completeLesson, syncProgress, fetchBanter } from './lib/server';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
const props = defineProps<{ apiUrl: string; lessons: any }>();

// ---------------------------------------------------------------------------
// Screen state machine
// ---------------------------------------------------------------------------
const screen = ref<'landing' | 'map' | 'lesson' | 'results'>('landing');

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------
const progress = ref(loadLocal());

const mastered = computed(() => progress.value.mastered);

// ---------------------------------------------------------------------------
// Active lesson
// ---------------------------------------------------------------------------
const activeLessonId = ref<string | null>(null);
const activeLesson = computed(() => {
  if (!activeLessonId.value) return null;
  for (const unit of props.lessons.units) {
    for (const lesson of unit.lessons) {
      if (lesson.id === activeLessonId.value) return lesson;
    }
  }
  return null;
});

// Results state
const lastXp = ref(0);
const banterLine = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function handleSelect(lessonId: string) {
  activeLessonId.value = lessonId;
  screen.value = 'lesson';
}

async function handleLessonComplete(lessonId: string) {
  const lesson = activeLesson.value;
  // The lesson component has its own session XP — we need to find the lesson
  // to grab the metadata for server calls.
  if (!lesson) return;

  // Add to mastered and update XP/streak locally
  const updated = mergeProgress(progress.value, {
    xp: progress.value.xp + 10, // At least 1 correct answer
    streak: progress.value.streak + 1,
    mastered: [lessonId],
  });
  progress.value = updated;
  saveLocal(updated);

  // Best-effort server sync — never await result in a blocking way
  const auth = await isAuthenticated();
  if (auth) {
    // Fire both, no await — fail-open
    completeLesson(props.apiUrl, {
      lessonSlug: lessonId,
      legacyId: lesson.legacyId,
      title: lesson.title,
    }).then(result => {
      if (result) {
        // Server accepted, also sync full progress
        syncProgress(props.apiUrl, progress.value).then(remote => {
          if (remote) {
            const merged = mergeProgress(progress.value, remote);
            progress.value = merged;
            saveLocal(merged);
          }
        });
      }
    });
  }

  // Opportunistic banter — fail-open
  lastXp.value = updated.xp;
  fetchBanter(props.apiUrl, `lesson_complete:${lessonId}`).then(line => {
    banterLine.value = line;
  });

  screen.value = 'results';
}

function handleContinue() {
  // Go back to map to pick the next lesson
  screen.value = 'map';
}

function handleBack() {
  screen.value = 'map';
}
</script>

<template>
  <div class="ktt-root" :data-screen="screen">
    <!-- Landing -->
    <section v-if="screen === 'landing'" class="ktt-landing">
      <KasimirStage mood="idle" />
      <h1>Professor Kasimir Teaches TLAs</h1>
      <p>SAP has more three-letter acronyms than a cat has naps. Let's fix that.</p>
      <button data-testid="ktt-start" @click="screen = 'map'">Start</button>
    </section>

    <!-- Skill Tree Map -->
    <section v-else-if="screen === 'map'" class="ktt-map">
      <SkillTreeMap
        :lessons="lessons"
        :mastered="mastered"
        @select="handleSelect"
      />
    </section>

    <!-- Active Lesson -->
    <section v-else-if="screen === 'lesson' && activeLesson" class="ktt-lesson-screen">
      <Lesson
        :lesson="activeLesson"
        @complete="handleLessonComplete"
      />
    </section>

    <!-- Results -->
    <section v-else-if="screen === 'results' && activeLesson" class="ktt-results-screen">
      <Results
        :xp="lastXp"
        :lesson-id="activeLessonId!"
        :lesson-title="activeLesson.title"
        :banter-line="banterLine"
        @continue="handleContinue"
        @back="handleBack"
      />
    </section>
  </div>
</template>
