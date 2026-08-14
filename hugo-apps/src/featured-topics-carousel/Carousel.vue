<template>
  <div class="hp-featured-carousel__body">
    <!-- #1782 mode toggle -->
    <div class="hp-featured-carousel__modeswitch" role="group" aria-label="Ranking mode">
      <button type="button" class="hp-featured-carousel__mode"
              :class="{ 'is-active': mode === 'featured' }"
              :aria-pressed="mode === 'featured'" @click="switchMode('featured')">Featured</button>
      <button type="button" class="hp-featured-carousel__mode"
              :class="{ 'is-active': mode === 'top' }"
              :aria-pressed="mode === 'top'" @click="switchMode('top')">Top Tutorials</button>
    </div>
    <!-- #1782 window selector — only in Top Tutorials mode -->
    <div v-if="mode === 'top'" class="hp-featured-carousel__windows" role="group" aria-label="Time window">
      <button v-for="w in WINDOW_OPTIONS" :key="w" type="button"
              class="hp-featured-carousel__window" :class="{ 'is-active': windowDays === w }"
              :aria-pressed="windowDays === w" @click="setWindow(w)">{{ w }}d</button>
    </div>

    <div class="hp-featured-carousel__viewport" aria-live="polite" tabindex="0" @keydown="onKey">
      <div
        v-for="(slide, i) in displaySlides"
        :key="slide.conceptSlug"
        class="hp-featured-carousel__slide"
        :class="{ 'is-active': i === active, 'hidden': i !== active }"
        :id="'featured-' + slide.conceptSlug"
        role="group"
        aria-roledescription="slide"
        :aria-label="slide.displayTitle + ', slide ' + (i + 1) + ' of ' + displaySlides.length"
      >
        <h3 class="hp-featured-carousel__topic">{{ slide.displayTitle }}</h3>
        <!-- v-html is safe: content is server-sanitized SSR or esc()-escaped in the composables. -->
        <div class="hp-featured-carousel__grid cards" v-html="slide.missionsHtml"></div>
      </div>
      <p v-if="mode === 'top' && displaySlides.length === 0" class="hp-featured-carousel__empty">
        No tutorial completions in the last {{ windowDays }} days yet.
      </p>
    </div>

    <nav class="hp-featured-carousel__controls" aria-label="Carousel controls">
      <button type="button" @click="prev" aria-label="Previous topic">‹</button>
      <button type="button" @click="togglePlay" :aria-pressed="!autoAdvance"
              :aria-label="autoAdvance ? 'Pause auto-advance' : 'Resume auto-advance'">
        {{ autoAdvance ? '⏸' : '▶' }}
      </button>
      <button type="button" @click="next" aria-label="Next topic">›</button>
      <ol class="hp-featured-carousel__dots" role="tablist">
        <li v-for="(slide, i) in displaySlides" :key="slide.conceptSlug" role="presentation">
          <button type="button" role="tab"
                  :aria-selected="i === active ? 'true' : 'false'"
                  :aria-label="'Show ' + slide.displayTitle" @click="userJumpTo(i)"></button>
        </li>
      </ol>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useAutoAdvance } from './composables/useAutoAdvance';
import { useHydrate } from './composables/useHydrate';
import { useDeepLink } from './composables/useDeepLink';
import { buildTopTutorialSlides, fetchTopTutorials, type TopTutorialWindow } from './composables/useTopTutorials';
import { readLocalStorageWindow, writeLocalStorageWindow, DEFAULT_WINDOW, WINDOW_OPTIONS } from './window-storage';

const props = defineProps<{
  root: HTMLElement;
  initialEtag: string;
  initialSlides: Array<{ conceptSlug: string; displayTitle: string; missionsHtml: string }>;
}>();

type Mode = 'featured' | 'top';
const mode = ref<Mode>('featured');
const windowDays = ref<number>(readLocalStorageWindow() ?? DEFAULT_WINDOW);

const featuredSlides = ref(props.initialSlides);
const topWindows = ref<TopTutorialWindow[]>([]);
const topLoaded = ref(false);

const active = ref(0);
const userPaused = ref(false);
const reducedMotion = ref(
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
);
const autoAdvance = computed(() => !userPaused.value && !reducedMotion.value);

const displaySlides = computed(() =>
  mode.value === 'featured'
    ? featuredSlides.value
    : buildTopTutorialSlides(topWindows.value, windowDays.value),
);

// Reveal the row as soon as either mode has slides (same fallback contract as #1032).
watch(displaySlides, (next) => {
  if (next.length > 0) props.root.classList.remove('hp-featured-carousel--pending');
}, { immediate: true });

async function switchMode(m: Mode): Promise<void> {
  mode.value = m;
  active.value = 0;
  userPaused.value = true; // a deliberate interaction pauses auto-advance
  if (m === 'top' && !topLoaded.value) {
    topLoaded.value = true;
    topWindows.value = await fetchTopTutorials();
  }
}

function setWindow(w: number): void {
  windowDays.value = w;
  writeLocalStorageWindow(w);
  active.value = 0;
}

function jumpTo(i: number): void {
  if (i < 0 || i >= displaySlides.value.length) return;
  active.value = i;
  if (typeof history !== 'undefined') {
    history.replaceState(null, '', `#featured/${displaySlides.value[i].conceptSlug}`);
  }
}
function next(): void { jumpTo((active.value + 1) % Math.max(1, displaySlides.value.length)); userPaused.value = true; }
function prev(): void { jumpTo((active.value - 1 + displaySlides.value.length) % Math.max(1, displaySlides.value.length)); userPaused.value = true; }
function togglePlay(): void { userPaused.value = !userPaused.value; }
function userJumpTo(i: number): void { jumpTo(i); userPaused.value = true; }
function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
}

useAutoAdvance({
  intervalMs: 8_000,
  enabled: autoAdvance,
  container: () => props.root,
  tick: () => jumpTo((active.value + 1) % Math.max(1, displaySlides.value.length)),
});

// Featured hydration (unchanged): only feeds featuredSlides.
useHydrate({ etag: props.initialEtag, onFresh: (fresh) => { featuredSlides.value = fresh; } });

useDeepLink({
  slides: displaySlides as any,
  onResolve: (i) => { active.value = i; userPaused.value = true; },
});

defineExpose({ next, prev, jumpTo, userJumpTo, togglePlay, switchMode, setWindow, active, userPaused, autoAdvance, mode, windowDays });
</script>
