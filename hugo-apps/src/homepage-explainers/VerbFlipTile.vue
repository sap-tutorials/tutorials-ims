<script setup lang="ts">
// VerbFlipTile.vue — flip card on verb-spine tiles + verb-sub-page shelf headers.
// Spec: #759 §1.3 / §4.1

import { computed } from 'vue';
import { useFlipCard } from '../advocates/composables/useFlipCard';
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
}>();

// cardEl from useFlipCard is a regular Vue ref<HTMLElement|null>; binding
// `ref="cardEl"` on the root <component :is="..."> in setup-script syntax
// auto-wires it (Vue 3.5's <script setup> template-ref convention).
const { flipped, cardEl, toggle, unflip } = useFlipCard();
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
  // If the tile has an href and we're on the front face, navigate.
  // If we're on the back face, toggle back to front (the user clicked away).
  // If no href (shelf-header mode), toggle.
  if (!flipped.value && props.href) {
    // Allow default <a> navigation; nothing else needed.
    return;
  }
  e.preventDefault();
  toggle();
}
</script>

<template>
  <component
    :is="props.href ? 'a' : 'div'"
    ref="cardEl"
    class="hp-flip"
    :class="{ 'hp-flip--verb': isVerb, 'hp-flip--shelf': !isVerb }"
    :href="props.href || undefined"
    role="button"
    :tabindex="0"
    :aria-pressed="flipped"
    :aria-label="`Toggle details for ${label}`"
    :data-flipped="flipped.toString()"
    @click="onClick"
    @pointerenter="handleEnter"
    @pointerleave="handleLeave"
  >
    <div class="hp-flip__inner">
      <div class="hp-flip__face hp-flip__face--front">
        <div v-if="iconName" class="hp-verb__icon" aria-hidden="true">
          <ui5-icon :name="iconName"></ui5-icon>
        </div>
        <div class="hp-verb__label">{{ label }}</div>
        <slot />
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
