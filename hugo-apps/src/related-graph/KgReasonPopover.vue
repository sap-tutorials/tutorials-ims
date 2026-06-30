<!--
  hugo-apps/src/related-graph/KgReasonPopover.vue
  KG sidebar hover-reason popover (KG widget UX polish, 2026-06-30).

  Replaces the native HTML `title=` tooltip on each KG sidebar link with a
  real `<ui5-popover>`. Native title tooltips delay ~1 second, can't be
  styled, never appear for keyboard users, and never appear on touch. This
  honors the on-screen promise from RelatedGraph.vue's intro copy:
  "Hover any link to see why it appears here."

  Trigger model (chosen 2026-06-30): open on mouseover OR focus, close on
  mouseout/blur after a ~180ms grace period so a cursor traversing the
  small gap between the link and the popover body doesn't tear down the
  open state. Mirrors the pattern from #759's LinkExplainerPopover via the
  shared `useHoverIntent` composable.

  This component renders its OWN trigger (a `<span>` wrapping the link or
  concept name) so the consumer doesn't have to thread `aria-describedby`,
  hover handlers, and popover-opener wiring through four sites. Consumers
  pass:
    - text — the trigger text (the link label or concept name)
    - reason — the hover-reason string; empty/missing → no popover at all
    - href — when present, the trigger renders as a real <a>; otherwise <span>
    - linkClass / target / rel — passed through to the <a> when present
  …and the component handles the rest.

  Bundle-budget note: `<ui5-popover>` is registered globally by
  hugo/assets/js/ui5-bootstrap.ts:20 so this island doesn't ship its own
  copy. Net add to related-graph.js is the trigger wiring + the composable
  (≈1 KB gzipped against an 8.6 KB headroom).

  Accessibility: when the popover is open, the trigger gets
  `aria-describedby` pointing to the popover's heading id. A screen reader
  thus announces "next step — builds on what this tutorial teaches"
  after the link text on focus. Closed → attribute is absent so it doesn't
  point at nothing.
-->
<template>
  <!--
    Use a real <a> when href is provided so the link follows on click;
    fall back to <span> for label-only triggers (e.g. unpublished concept
    names where there's no destination). The grace-period leave handler
    fires from EITHER the trigger or the popover body — re-entering either
    cancels a pending close, letting the cursor bridge from link → popover.
  -->
  <a
    v-if="href"
    :href="href"
    :class="linkClass"
    :target="target ?? undefined"
    :rel="rel ?? undefined"
    :aria-describedby="open ? popoverHeadingId : undefined"
    @mouseenter="onTriggerEnter"
    @mouseleave="onTriggerLeave"
    @focus="onTriggerEnter"
    @blur="onTriggerLeave"
    @click="$emit('click')"
    ref="triggerEl"
  >
    <slot>{{ text }}</slot>
  </a>
  <span
    v-else
    :class="linkClass"
    :aria-describedby="open ? popoverHeadingId : undefined"
    tabindex="0"
    @mouseenter="onTriggerEnter"
    @mouseleave="onTriggerLeave"
    @focus="onTriggerEnter"
    @blur="onTriggerLeave"
    ref="triggerEl"
  >
    <slot>{{ text }}</slot>
  </span>
  <!--
    Popover lives outside the trigger so mouse-leave events from the
    trigger don't bubble through it. We re-attach hover handlers to the
    popover body so the cursor can bridge link → popover without losing
    the open state.
    placement="End" sits the popover to the right of the trigger when
    there's room; UI5 auto-flips on overflow. hide-arrow keeps the visual
    light — there's no need for a directional arrow on a tooltip-style
    popover that uses the body width as its visual anchor.
  -->
  <ui5-popover
    v-if="reason"
    ref="popoverRef"
    placement="End"
    hide-arrow
    @mouseenter="onPopoverEnter"
    @mouseleave="onPopoverLeave"
  >
    <p :id="popoverHeadingId" class="kg-reason-text">{{ reason }}</p>
  </ui5-popover>
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { useHoverIntent } from '../homepage-explainers/composables/useHoverIntent'

// Module-scope id counter — used for stable `aria-describedby` targets.
// Declared at the top so the call in `popoverHeadingId` below executes
// after initialization (avoids the TDZ ReferenceError that bites if the
// declaration is hoisted to the bottom of the script-setup block).
let _idCounter = 0
function nextId(): number { return ++_idCounter }

const props = defineProps<{
  text?: string
  reason?: string | null
  href?: string | null
  linkClass?: string
  target?: string | null
  rel?: string | null
}>()

defineEmits<{ (e: 'click'): void }>()

const triggerEl = ref<HTMLElement | null>(null)
const popoverRef = ref<HTMLElement | null>(null)
const open = ref(false)

// Stable id per popover instance so `aria-describedby` points at a real
// node. Using a module-scope counter avoids the cost of a per-instance
// crypto.randomUUID() — there are ~30 popovers per page at most.
const popoverHeadingId = `kg-reason-${nextId()}`

// Hover-intent: 60 ms enter delay filters out cursor flyovers; 180 ms
// leave delay lets the cursor bridge from trigger → popover body without
// the popover collapsing first. Same numbers as #759's link explainer.
const { handleEnter, handleLeave } = useHoverIntent({
  delayMs: 60,
  leaveDelayMs: 180,
  onEnter: () => {
    // Guard: no popover element if `reason` is falsy.
    const trigger = triggerEl.value
    const pop = popoverRef.value as any
    if (!trigger || !pop) return
    pop.opener = trigger
    pop.open = true
    open.value = true
  },
  onLeave: () => {
    const pop = popoverRef.value as any
    if (!pop) return
    pop.open = false
    open.value = false
  },
})

// Wire the same handler set to BOTH the trigger and the popover body so a
// cursor crossing the (UI5-default ~2 px) gap stays inside the hover-window.
function onTriggerEnter()  { if (props.reason) handleEnter() }
function onTriggerLeave()  { handleLeave() }
function onPopoverEnter()  { if (props.reason) handleEnter() }
function onPopoverLeave()  { handleLeave() }

onBeforeUnmount(() => {
  // Close any open popover on unmount so a navigation away doesn't strand
  // an orphaned ui5-popover (which can persist as a body-level element).
  const pop = popoverRef.value as any
  if (pop?.open) pop.open = false
})
</script>

<style scoped>
.kg-reason-text {
  margin: 0;
  padding: 0.5rem 0.75rem;
  max-width: 22rem;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--sapTextColor, #32363a);
}
</style>
