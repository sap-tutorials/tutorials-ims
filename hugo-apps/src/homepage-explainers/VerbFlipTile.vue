<script setup lang="ts">
// VerbFlipTile.vue — flip card on verb-spine tiles + verb-sub-page shelf headers.
// Spec: #759 §1.3 / §4.1

import { computed, ref } from 'vue';
import { useHoverIntent } from './composables/useHoverIntent';
import { useReducedMotion } from './composables/useReducedMotion';
import './styles/flip-card.css';

const props = defineProps<{
  verbKey?: string;
  shelfKey?: string;
  label: string;
  iconName?: string;
  tagline?: string;
  whyItMatters?: string;
  href?: string;
  /**
   * JSON-encoded array of START_HERE preview titles for verb-spine tiles.
   * E.g. data-preview="[\"Tutorial 1\",\"Tutorial 2\"]". Empty / missing
   * for shelf-header mode and verbs with no START_HERE items.
   * (#759 hotfix — Vue createApp.mount(el) wipes el's children, so the
   * Hugo first-paint <ul> doesn't survive hydration; pass via JSON instead.)
   */
  preview?: string;
}>();

const previewItems = computed<string[]>(() => {
  if (!props.preview) return [];
  try { return JSON.parse(props.preview) as string[]; }
  catch { return []; }
});

// Local flip state — we don't reuse advocates/useFlipCard because that
// composable conflates Space + Enter (both toggle), and our spec §1.3
// requires Enter to NAVIGATE on verb tiles. The keyboard contract is
// short enough to inline; reuse here would have leaked the wrong
// semantics.
const flipped = ref(false);
const cardEl = ref<HTMLElement | null>(null);

const reduced = useReducedMotion();
const { handleEnter, handleLeave } = useHoverIntent({
  delayMs: 250,
  reducedMotion: reduced,
  onEnter: () => { flipped.value = true; },
  onLeave: () => { flipped.value = false; },
});

const isVerb = computed(() => !!props.verbKey);
const hasBackContent = computed(() => !!(props.tagline || props.whyItMatters));

function onClick(e: MouseEvent) {
  // Verb tile (has href): a click ALWAYS navigates — even when hover-intent
  // has already flipped the card to its back face. Previously a click on the
  // flipped face just flipped it back to the front, so users had to click
  // twice to navigate (issue #1596). Navigation is the primary action; the
  // flip is a passive hover affordance, so let the default <a> click through.
  if (props.href) return;
  // Shelf header (no href): click toggles the flip.
  e.preventDefault();
  flipped.value = !flipped.value;
}

function onKeydown(e: KeyboardEvent) {
  // Spec §1.3 keyboard contract:
  //   Space        → toggle flip (always)
  //   Enter        → navigate (verbs); no-op (shelf headers — no href anyway)
  //   Escape       → unflip when currently flipped
  if (e.key === ' ') {
    e.preventDefault();
    flipped.value = !flipped.value;
  } else if (e.key === 'Enter') {
    // Allow default <a> navigation; do NOT call preventDefault().
    // For shelf-header mode (no href), the default Enter on a focusable
    // div is a no-op, which matches the spec.
  } else if (e.key === 'Escape' && flipped.value) {
    e.preventDefault();
    flipped.value = false;
    cardEl.value?.focus();
  }
}

// aria-label varies by mode:
//   verb tile: emphasises the link action ("Go to <label> or press Space for details")
//   shelf header: classic toggle-button label
const ariaLabel = computed(() =>
  props.href
    ? `Go to ${props.label}, or press Space for details`
    : `Toggle details for ${props.label}`
);
</script>

<template>
  <!--
    #1794 axe (WCAG A/AA) fixes:
    - aria-pressed is only valid on role=button, NOT on the <a> (role=link)
      verb-tile variant, so it's bound only in shelf-header (button) mode.
      The link's flip affordance is conveyed via aria-label instead.
    - The back face is a scroll container (long whyItMatters prose, #793); it's
      made keyboard-focusable while flipped so keyboard users can scroll it
      (scrollable-region-focusable). The matching CSS only turns overflow-y on
      while flipped, so the hidden default state isn't a phantom tab stop.
  -->
  <component
    :is="props.href ? 'a' : 'div'"
    ref="cardEl"
    class="hp-flip"
    :class="{ 'hp-flip--verb': isVerb, 'hp-flip--shelf': !isVerb }"
    :href="props.href || undefined"
    :role="props.href ? undefined : 'button'"
    :tabindex="props.href ? undefined : 0"
    :aria-pressed="props.href ? undefined : flipped"
    :aria-label="ariaLabel"
    :data-flipped="flipped.toString()"
    @click="onClick"
    @keydown="onKeydown"
    @pointerenter="handleEnter"
    @pointerleave="handleLeave"
  >
    <div class="hp-flip__inner">
      <div class="hp-flip__face hp-flip__face--front">
        <div v-if="iconName" class="hp-verb__icon" aria-hidden="true">
          <ui5-icon :name="iconName"></ui5-icon>
        </div>
        <div class="hp-verb__label">{{ label }}</div>
        <ul v-if="previewItems.length > 0" class="hp-verb__preview" :aria-label="`${label} highlights`">
          <li v-for="(item, i) in previewItems" :key="i">{{ item }}</li>
        </ul>
      </div>
      <div
        class="hp-flip__face hp-flip__face--back"
        :tabindex="flipped ? 0 : undefined"
      >
        <p class="hp-flip__back-label">{{ label }}</p>
        <p v-if="tagline" class="hp-flip__tagline">{{ tagline }}</p>
        <p v-if="whyItMatters" class="hp-flip__why">{{ whyItMatters }}</p>
        <p v-if="!hasBackContent" class="hp-flip__placeholder">
          More details coming soon.
        </p>
      </div>
    </div>
  </component>
</template>
