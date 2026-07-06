<script setup lang="ts">
// ShelfHeaderPopover.vue — inline <h2> + ⓘ popover for verb sub-page shelf
// headers (#1020, Tom feedback).
//
// Replaces the flip-tile shelf headers rendered by VerbFlipTile in
// "shelf" mode. That component reserved ~96 px of vertical space per
// header so the flip animation had somewhere to land — visually reading
// as an empty gap under each section heading (`Start here`, `Reference`,
// …) on `/ai/`, `/build/`, `/connect/`, `/integrate/`, `/learn/`,
// `/operate/`. Swapping to an inline ⓘ mirrors the pattern already used
// on the shelf's link cards (LinkExplainerPopover) and lets the section
// title sit tight against the cards below it.
//
// Behaviour is the same click-or-hover popover contract as
// LinkExplainerPopover; only the anchor markup differs (<h2> instead of
// <a>).

import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useHoverIntent } from './composables/useHoverIntent';
import { useReducedMotion } from './composables/useReducedMotion';
import { usePopoverPosition } from './composables/usePopoverPosition';
import './styles/popover.css';
import './styles/shelf-header.css';

const props = defineProps<{
  shelfKey?: string;
  label: string;
  tagline?: string;
  whyItMatters?: string;
}>();

const hasContent = computed(() => !!(props.tagline || props.whyItMatters));

const open = ref(false);
const openedViaClick = ref(false);
const anchorEl = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const iconBtnEl = ref<HTMLButtonElement | null>(null);

const reduced = useReducedMotion();
const { handleEnter, handleLeave } = useHoverIntent({
  delayMs: 250,
  leaveDelayMs: 180,
  reducedMotion: reduced,
  onEnter: () => {
    if (!openedViaClick.value) {
      open.value = true;
      recompute();
    }
  },
  onLeave: () => { if (!openedViaClick.value) open.value = false; },
});

const { placement, alignment, recompute } = usePopoverPosition({ anchorEl });

function onIconClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  if (!open.value) {
    open.value = true;
    openedViaClick.value = true;
    recompute();
  } else if (!openedViaClick.value) {
    openedViaClick.value = true;  // upgrade tooltip → dialog
  } else {
    open.value = false;
    openedViaClick.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    open.value = false;
    openedViaClick.value = false;
    iconBtnEl.value?.focus();
  }
}

function onDocClick(e: Event) {
  if (!open.value || !openedViaClick.value) return;
  const target = e.target as Node | null;
  if (anchorEl.value && !anchorEl.value.contains(target)) {
    open.value = false;
    openedViaClick.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  window.addEventListener('resize', recompute);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('resize', recompute);
});
</script>

<template>
  <div ref="anchorEl" class="hp-shelf-header hp-popover-anchor">
    <h2 class="hp-shelf-header__label">{{ label }}</h2>
    <button
      v-if="hasContent"
      ref="iconBtnEl"
      class="hp-popover-icon hp-shelf-header__icon"
      type="button"
      :aria-label="`More about ${label}`"
      :aria-expanded="open"
      @click="onIconClick"
      @pointerenter="handleEnter"
      @pointerleave="handleLeave"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="6.5" fill="none" stroke="currentColor" />
        <text x="7" y="10" text-anchor="middle" font-size="9"
              font-family="serif" font-weight="bold" fill="currentColor">i</text>
      </svg>
    </button>
    <div
      v-if="open && hasContent"
      ref="popoverEl"
      class="hp-popover"
      role="tooltip"
      :data-placement="placement"
      :data-alignment="alignment"
      tabindex="-1"
      @keydown="onKey"
      @pointerenter="handleEnter"
      @pointerleave="handleLeave"
    >
      <p v-if="tagline" class="hp-popover__tagline">{{ tagline }}</p>
      <p v-if="whyItMatters" class="hp-popover__why">{{ whyItMatters }}</p>
    </div>
  </div>
</template>
