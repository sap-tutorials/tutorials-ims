<template>
  <!-- Single root wrapper keeps Vue test-utils find() working across all children.
       The outer <section> is the mount host; this div carries Vue's reactive tree. -->
  <div class="hp-featured-carousel__body">
    <div
      class="hp-featured-carousel__viewport"
      aria-live="polite"
      tabindex="0"
      @keydown="onKey"
    >
      <div
        v-for="(slide, i) in slides"
        :key="slide.conceptSlug"
        class="hp-featured-carousel__slide"
        :class="{ 'is-active': i === active, 'hidden': i !== active }"
        :id="'featured-' + slide.conceptSlug"
        role="group"
        aria-roledescription="slide"
        :aria-label="slide.displayTitle + ', slide ' + (i + 1) + ' of ' + slides.length"
      >
        <h3 class="hp-featured-carousel__topic">{{ slide.displayTitle }}</h3>
        <!-- v-html is safe: content comes from Hugo SSR templates (server-sanitized)
             or buildCardHtml() in useHydrate which esc()-escapes all dynamic values. -->
        <div class="hp-featured-carousel__grid cards" v-html="slide.missionsHtml"></div>
      </div>
    </div>
    <nav class="hp-featured-carousel__controls" aria-label="Carousel controls">
      <button type="button" @click="prev" aria-label="Previous topic">‹</button>
      <button
        type="button"
        @click="togglePlay"
        :aria-pressed="!autoAdvance"
        :aria-label="autoAdvance ? 'Pause auto-advance' : 'Resume auto-advance'"
      >
        {{ autoAdvance ? '⏸' : '▶' }}
      </button>
      <button type="button" @click="next" aria-label="Next topic">›</button>
      <ol class="hp-featured-carousel__dots" role="tablist">
        <li v-for="(slide, i) in slides" :key="slide.conceptSlug" role="presentation">
          <button
            type="button"
            role="tab"
            :aria-selected="i === active ? 'true' : 'false'"
            :aria-label="'Show ' + slide.displayTitle"
            @click="userJumpTo(i)"
          ></button>
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

const props = defineProps<{
  root: HTMLElement;
  initialEtag: string;
  initialSlides: Array<{ conceptSlug: string; displayTitle: string; missionsHtml: string }>;
}>();

const slides = ref(props.initialSlides);
const active = ref(0);
const userPaused = ref(false);
const reducedMotion = ref(
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches
);
const autoAdvance = computed(() => !userPaused.value && !reducedMotion.value);

// #1032 fallback path — Hugo partial always emits the section (so JS can
// hydrate a stale/empty baked snapshot), tagged with .hp-featured-carousel--pending
// while empty. Reveal the row as soon as we have slides — from SSR or hydration.
// If hydration never fires (no JS, network fail, /homepage/featuredTopics() returns
// empty), the row stays hidden, preserving the pre-fix "silent no-show" UX for
// the truly-empty case.
watch(slides, (next) => {
  if (next.length > 0) props.root.classList.remove('hp-featured-carousel--pending');
}, { immediate: true });

function jumpTo(i: number): void {
  if (i < 0 || i >= slides.value.length) return;
  active.value = i;
  if (typeof history !== 'undefined') {
    history.replaceState(null, '', `#featured/${slides.value[i].conceptSlug}`);
  }
}

function next(): void {
  jumpTo((active.value + 1) % Math.max(1, slides.value.length));
  userPaused.value = true;
}

function prev(): void {
  jumpTo((active.value - 1 + slides.value.length) % Math.max(1, slides.value.length));
  userPaused.value = true;
}

function togglePlay(): void {
  userPaused.value = !userPaused.value;
}

function userJumpTo(i: number): void {
  jumpTo(i);
  userPaused.value = true;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') {
    prev();
    e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    next();
    e.preventDefault();
  }
}

useAutoAdvance({
  intervalMs: 8_000,
  enabled: autoAdvance,
  container: () => props.root,
  tick: () => jumpTo((active.value + 1) % Math.max(1, slides.value.length)),
});

useHydrate({
  etag: props.initialEtag,
  onFresh: (fresh) => { slides.value = fresh; },
});

useDeepLink({
  slides,
  onResolve: (i) => {
    active.value = i;
    userPaused.value = true;
  },
});

// Expose for unit tests (test-utils cannot reach script-setup internals otherwise).
defineExpose({ next, prev, jumpTo, userJumpTo, togglePlay, active, userPaused, autoAdvance });
</script>
