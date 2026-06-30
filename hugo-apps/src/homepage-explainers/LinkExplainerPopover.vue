<script setup lang="ts">
// LinkExplainerPopover.vue — hover-or-click popover on link entries.
// Spec: #759 §1.3 / §4.1

import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useHoverIntent } from './composables/useHoverIntent';
import { useReducedMotion } from './composables/useReducedMotion';
import { usePopoverPosition } from './composables/usePopoverPosition';
import './styles/popover.css';

const props = defineProps<{
  entryId: string;
  title: string;
  tagline?: string;
  whyItMatters?: string;
  description?: string;
  href: string;
  badge?: string;
  isExternal?: string;  // 'true' / 'false' / undefined — Hugo writes it as a string in data-*
}>();

const hasContent = computed(() => !!(props.tagline || props.whyItMatters || props.description));
const isExternalLink = computed(() => props.isExternal === 'true' || props.isExternal === '1');

const open = ref(false);
const openedViaClick = ref(false);  // role=dialog if clicked, role=tooltip if hovered
const anchorEl = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const iconBtnEl = ref<HTMLButtonElement | null>(null);

const reduced = useReducedMotion();
const { handleEnter, handleLeave } = useHoverIntent({
  delayMs: 250,
  reducedMotion: reduced,
  onEnter: () => {
    if (!openedViaClick.value) {
      open.value = true;
      recompute();  // position before first paint to avoid viewport-edge overflow
    }
  },
  onLeave: () => { if (!openedViaClick.value) open.value = false; },
});

const { placement, alignment, recompute } = usePopoverPosition({ anchorEl });

function onIconClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  // Four-case state machine:
  //   closed + click          → open as dialog (pinned)
  //   open-as-tooltip + click → upgrade to dialog (pinned)
  //   open-as-dialog + click  → close
  //   (closed + outside-click handled by onDocClick)
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
  <div ref="anchorEl" class="hp-popover-anchor">
    <!--
      Vue's createApp(component).mount(el) REPLACES el's children. The
      first-paint <a>Title</a> rendered by Hugo gets wiped on hydration,
      so we MUST render the link from props here — a <slot /> would be
      empty and the link text would vanish. (#759 hotfix — link-wipe bug.)

      Renders the rich form (strong title + optional badge) used by the
      verb-sub-page list. The directory footer uses the same component
      and inherits the same rendering — looks slightly bolder than before
      but reads cleanly in both contexts.
    -->
    <a
      class="hp-popover-link"
      :href="href"
      :target="isExternalLink ? '_blank' : undefined"
      :rel="isExternalLink ? 'noopener' : undefined"
    >
      <strong>{{ title }}</strong>
      <span v-if="badge" :class="['badge', 'badge--' + badge.toLowerCase()]">{{ badge }}</span>
    </a>
    <!--
      Hover handler is on the ⓘ button (not the anchor div) so hovering
      the link text stays bare — only explicit ⓘ-hover triggers
      the popover. Discoverability is the ⓘ icon itself.
    -->
    <button
      v-if="hasContent"
      ref="iconBtnEl"
      class="hp-popover-icon"
      type="button"
      :aria-label="`More about ${title}`"
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
    >
      <p v-if="tagline" class="hp-popover__tagline">{{ tagline }}</p>
      <p v-if="whyItMatters" class="hp-popover__why">{{ whyItMatters }}</p>
      <p v-if="description" class="hp-popover__description">{{ description }}</p>
    </div>
  </div>
</template>
