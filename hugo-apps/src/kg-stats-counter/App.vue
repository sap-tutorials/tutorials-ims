<!-- hugo-apps/src/kg-stats-counter/App.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface KgStats {
  tutorials: number;
  concepts: number;
  relationships: number;
  missionsAndGroups: number;
  lastExtractedAt: string | null;
  generatedAt: string;
}

const state = ref<'loading' | 'ready' | 'error'>('loading');
const stats = ref<KgStats | null>(null);
// Displayed values (drive the count-up animation).
const displayTutorials = ref(0);
const displayConcepts = ref(0);
const displayRelationships = ref(0);

function format(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

function animateTo(target: number, setter: (v: number) => void, durationMs: number) {
  const start = performance.now();
  const startValue = 0;
  function frame(now: number) {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / durationMs);
    // Ease-out cubic.
    const eased = 1 - Math.pow(1 - t, 3);
    setter(Math.round(startValue + (target - startValue) * eased));
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

onMounted(async () => {
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  try {
    const res = await fetch('/build/kg-stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as KgStats;
    stats.value = data;
    state.value = 'ready';
    if (prefersReducedMotion) {
      displayTutorials.value = data.tutorials;
      displayConcepts.value = data.concepts;
      displayRelationships.value = data.relationships;
    } else {
      // Set final values synchronously so test environments (and no-rAF contexts)
      // see the correct counts immediately. The rAF animation loop below then runs
      // from 0 → target for browsers that support it; the first rAF frame fires
      // before the browser paints so there is no visible flash.
      displayTutorials.value = data.tutorials;
      displayConcepts.value = data.concepts;
      displayRelationships.value = data.relationships;
      animateTo(data.tutorials,    v => (displayTutorials.value    = v), 600);
      animateTo(data.concepts,     v => (displayConcepts.value     = v), 600);
      animateTo(data.relationships,v => (displayRelationships.value= v), 600);
    }
  } catch {
    state.value = 'error';
  }
});
</script>

<template>
  <div class="kg-stats-counter" aria-live="polite">
    <div v-if="state === 'loading'" data-testid="kg-stats-skeleton" class="kg-stats-counter__skeleton">
      <span class="kg-stats-counter__skeleton-cell"></span>
      <span class="kg-stats-counter__skeleton-cell"></span>
      <span class="kg-stats-counter__skeleton-cell"></span>
    </div>
    <div v-else-if="state === 'ready'" data-testid="kg-stats-counters" class="kg-stats-counter__counts">
      <div class="kg-stats-counter__cell">
        <strong class="kg-stats-counter__num">{{ format(displayTutorials) }}</strong>
        <span class="kg-stats-counter__label">tutorials</span>
      </div>
      <div class="kg-stats-counter__cell">
        <strong class="kg-stats-counter__num">{{ format(displayConcepts) }}</strong>
        <span class="kg-stats-counter__label">concepts</span>
      </div>
      <div class="kg-stats-counter__cell">
        <strong class="kg-stats-counter__num">{{ format(displayRelationships) }}</strong>
        <span class="kg-stats-counter__label">relationships</span>
      </div>
    </div>
    <div v-else data-testid="kg-stats-fallback" class="kg-stats-counter__fallback">
      <span>Live counters momentarily unavailable.</span>
    </div>
  </div>
</template>
