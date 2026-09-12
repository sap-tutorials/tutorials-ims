<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import KasimirStage from './components/KasimirStage.vue';
import SkillTreeMap from './components/SkillTreeMap.vue';
import Lesson from './components/Lesson.vue';
import Results from './components/Results.vue';
import { loadLocal, saveLocal, mergeProgress, type KttProgress } from './lib/progress';
import { isAuthenticated, completeLesson, syncProgress, fetchBanter, isKttEnabled } from './lib/server';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
const props = defineProps<{ apiUrl: string; lessons: any }>();

// ---------------------------------------------------------------------------
// Feature gate (spec §7.7) — probe the server on mount. While the flag is OFF
// the page fails closed: the drill engine never mounts and we never touch
// localStorage. null = still probing, true = enabled, false = coming soon.
// ---------------------------------------------------------------------------
const enabled = ref<boolean | null>(null);

// ---------------------------------------------------------------------------
// Screen state machine
// ---------------------------------------------------------------------------
const screen = ref<'landing' | 'map' | 'lesson' | 'results'>('landing');

// ---------------------------------------------------------------------------
// Progress — deferred: not loaded from localStorage until KTT is enabled.
// ---------------------------------------------------------------------------
const progress = ref<KttProgress | null>(null);

const mastered = computed(() => progress.value?.mastered ?? []);

onMounted(async () => {
  const ok = await isKttEnabled(props.apiUrl);
  enabled.value = ok;
  // Only touch localStorage once we know the feature is live.
  if (ok) progress.value = loadLocal();
});

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

async function handleLessonComplete(lessonId: string, sessionXp: number) {
  const lesson = activeLesson.value;
  if (!lesson || !progress.value) return;

  // Capture pre-merge XP so Results shows the earned delta for this session
  const prevXp = progress.value.xp;

  // Add to mastered and update XP/streak locally using real earned XP
  const updated = mergeProgress(progress.value, {
    xp: progress.value.xp + sessionXp,
    streak: progress.value.streak + 1,
    mastered: [lessonId],
  });
  progress.value = updated;
  saveLocal(updated);

  // Show the delta (= sessionXp after a clean lesson) so Results is always correct
  lastXp.value = updated.xp - prevXp;

  // Transition to results immediately — do NOT block on network
  screen.value = 'results';

  // Opportunistic banter — fail-open, updates after screen shows
  fetchBanter(props.apiUrl, `lesson_complete:${lessonId}`).then(line => {
    banterLine.value = line;
  });

  // Best-effort server sync — fire-and-forget in the background
  isAuthenticated().then(auth => {
    if (!auth) return;
    completeLesson(props.apiUrl, {
      lessonSlug: lessonId,
      legacyId: lesson.legacyId,
      title: lesson.title,
    }).then(result => {
      if (result && progress.value) {
        syncProgress(props.apiUrl, progress.value).then(remote => {
          if (remote && progress.value) {
            const merged = mergeProgress(progress.value, remote);
            progress.value = merged;
            saveLocal(merged);
          }
        });
      }
    });
  });
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
  <div class="ktt-root" :data-screen="screen" :data-enabled="enabled">
    <!-- Coming soon: KTT_ENABLED is OFF server-side — fail closed, no engine -->
    <section v-if="enabled === false" class="ktt-coming-soon" data-testid="ktt-coming-soon">
      <KasimirStage mood="idle" />
      <h1>Professor Kasimir Teaches TLAs</h1>
      <p>Kasimir is still sharpening his claws on this lesson plan. TLA school is coming soon — check back shortly.</p>
    </section>

    <!-- Enabled: the normal drill engine -->
    <template v-else-if="enabled === true">
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
    </template>
  </div>
</template>
