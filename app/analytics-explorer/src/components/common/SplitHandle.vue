<script setup lang="ts">
// Vertical drag handle for splitting two sibling panes inside a column-flex
// parent. Emits a normalized [0..1] ratio change; the parent applies it to
// each pane's flex-basis. Persists to localStorage when storageKey is given.
import { ref, watch, onBeforeUnmount } from 'vue'

const props = withDefaults(defineProps<{
  /** Initial split ratio for the TOP pane (0..1). */
  initial?: number
  /** localStorage key for persistence; omit for ephemeral. */
  storageKey?: string
  /** Min ratio for top pane. */
  min?: number
  /** Max ratio for top pane. */
  max?: number
}>(), { initial: 0.5, min: 0.15, max: 0.85 })

const emit = defineEmits<{ (e: 'update:ratio', value: number): void }>()

const ratio = ref(loadInitial())
emit('update:ratio', ratio.value)

function loadInitial() {
  if (!props.storageKey) return clamp(props.initial)
  try {
    const stored = localStorage.getItem(props.storageKey)
    if (stored == null) return clamp(props.initial)
    const n = Number(stored)
    return Number.isFinite(n) ? clamp(n) : clamp(props.initial)
  } catch { return clamp(props.initial) }
}

function clamp(v: number) {
  return Math.max(props.min, Math.min(props.max, v))
}

let parentEl: HTMLElement | null = null
let parentTop = 0
let parentHeight = 0
let dragging = false

function onMouseDown(e: MouseEvent) {
  // Find the column-flex parent so we can measure against its bounding rect.
  // The handle's parentElement IS that container per the SqlTab markup.
  const handle = e.currentTarget as HTMLElement
  parentEl = handle.parentElement
  if (!parentEl) return
  const rect = parentEl.getBoundingClientRect()
  parentTop = rect.top
  parentHeight = rect.height
  dragging = true
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  e.preventDefault()
}

function onMouseMove(e: MouseEvent) {
  if (!dragging || parentHeight === 0) return
  const offset = e.clientY - parentTop
  ratio.value = clamp(offset / parentHeight)
  emit('update:ratio', ratio.value)
}

function onMouseUp() {
  dragging = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

function onKeydown(e: KeyboardEvent) {
  // Keyboard a11y: ArrowUp/Down nudges 5%, Home/End jump to min/max.
  const step = 0.05
  let next = ratio.value
  if (e.key === 'ArrowUp') next -= step
  else if (e.key === 'ArrowDown') next += step
  else if (e.key === 'Home') next = props.min ?? 0.15
  else if (e.key === 'End') next = props.max ?? 0.85
  else return
  ratio.value = clamp(next)
  emit('update:ratio', ratio.value)
  e.preventDefault()
}

watch(ratio, v => {
  if (!props.storageKey) return
  try { localStorage.setItem(props.storageKey, String(v)) } catch { /* ignore */ }
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <div
    class="split-handle"
    role="separator"
    aria-orientation="horizontal"
    :aria-valuenow="Math.round(ratio * 100)"
    :aria-valuemin="Math.round((min ?? 0.15) * 100)"
    :aria-valuemax="Math.round((max ?? 0.85) * 100)"
    tabindex="0"
    title="Drag to resize. Arrow keys nudge."
    @mousedown="onMouseDown"
    @keydown="onKeydown"
  >
    <div class="grip" />
  </div>
</template>

<style scoped>
.split-handle {
  flex: 0 0 6px;
  height: 6px;
  cursor: row-resize;
  background: var(--sapList_HeaderBackground);
  border-top: 1px solid var(--sapField_BorderColor);
  border-bottom: 1px solid var(--sapField_BorderColor);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  outline: none;
}
.split-handle:hover, .split-handle:focus-visible {
  background: var(--sapButton_Hover_Background, var(--sapList_Hover_Background));
}
.grip {
  width: 32px;
  height: 2px;
  background: var(--sapNeutralTextColor);
  border-radius: 1px;
  opacity: 0.4;
}
.split-handle:hover .grip,
.split-handle:focus-visible .grip { opacity: 0.8; }
</style>
