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
  // Front face + has href → allow default <a> navigation.
  // Back face (any) → flip back to front.
  // Front face + no href (shelf header) → flip to back.
  if (!flipped.value && props.href) return;
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
  <component
    :is="props.href ? 'a' : 'div'"
    ref="cardEl"
    class="hp-flip"
    :class="{ 'hp-flip--verb': isVerb, 'hp-flip--shelf': !isVerb }"
    :href="props.href || undefined"
    :role="props.href ? undefined : 'button'"
    :tabindex="props.href ? undefined : 0"
    :aria-pressed="flipped"
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
      <div class="hp-flip__face hp-flip__face--back">
        <h3 class="hp-flip__back-label">{{ label }}</h3>
        <p v-if="tagline" class="hp-flip__tagline">{{ tagline }}</p>
        <p v-if="whyItMatters" class="hp-flip__why">{{ whyItMatters }}</p>
        <p v-if="!hasBackContent" class="hp-flip__placeholder">
          More details coming soon.
        </p>
      </div>
    </div>
  </component>
</template>
