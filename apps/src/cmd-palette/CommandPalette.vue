<!--
  Cmd+K command palette (U4).
  - Mounts globally via baseof.html.
  - Opens with ⌘K / Ctrl+K, also via shellbar search button.
  - Fuzzy-ish filter on a static action registry (jump to / theme / Joule /
    copy URL / report issue) plus live tutorial search via /search/SearchableItems.
  - Themed entirely with Horizon CSS variables — see scoped styles.
-->
<template>
  <div v-if="open" class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" @click="onBackdropClick">
    <div class="cmdk__panel" @click.stop>
      <div class="cmdk__input-row">
        <span class="cmdk__input-icon" aria-hidden="true">⌘</span>
        <input
          ref="inputRef"
          v-model="query"
          class="cmdk__input"
          type="text"
          placeholder="Search tutorials, jump to a step, or run an action…"
          aria-label="Command palette query"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="runActive()"
          @keydown.esc.prevent="close()"
        >
        <kbd class="cmdk__esc">Esc</kbd>
      </div>

      <div ref="listRef" class="cmdk__list" role="listbox">
        <template v-if="actionResults.length">
          <div class="cmdk__group-label">Actions</div>
          <button
            v-for="(item, i) in actionResults"
            :key="`a-${item.id}`"
            :class="['cmdk__item', { 'cmdk__item--active': activeIndex === i }]"
            role="option"
            :aria-selected="activeIndex === i"
            @mouseenter="activeIndex = i"
            @click="runItem(item)"
          >
            <span class="cmdk__item-icon" :data-icon="item.icon || 'circle-task'" aria-hidden="true"></span>
            <span class="cmdk__item-label">{{ item.label }}</span>
          </button>
        </template>

        <template v-if="tutorialResults.length">
          <div class="cmdk__group-label">Tutorials</div>
          <button
            v-for="(item, i) in tutorialResults"
            :key="`t-${item.id}`"
            :class="['cmdk__item', { 'cmdk__item--active': activeIndex === actionResults.length + i }]"
            role="option"
            :aria-selected="activeIndex === actionResults.length + i"
            @mouseenter="activeIndex = actionResults.length + i"
            @click="runItem(item)"
          >
            <span class="cmdk__item-icon" data-icon="course-book" aria-hidden="true"></span>
            <span class="cmdk__item-content">
              <span class="cmdk__item-label">{{ item.label }}</span>
              <span v-if="item.hint" class="cmdk__item-hint">{{ item.hint }}</span>
            </span>
          </button>
        </template>

        <div v-if="!actionResults.length && !tutorialResults.length" class="cmdk__empty">
          <template v-if="searching">Searching…</template>
          <template v-else-if="query.trim().length < 2">Type to search tutorials, or pick an action.</template>
          <template v-else>No matches.</template>
        </div>
      </div>

      <div class="cmdk__footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> select</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PaletteAction } from './actions'
import { PALETTE_ACTIONS, buildStepActions } from './actions'

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const searching = ref(false)
const tutorialResults = ref<PaletteAction[]>([])

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pageActions: PaletteAction[] = []

const allStaticActions = computed<PaletteAction[]>(() => [...pageActions, ...PALETTE_ACTIONS])

function fuzzyMatch(item: PaletteAction, q: string): boolean {
  if (!q) return true
  const haystack = (item.label + ' ' + (item.keywords?.join(' ') || '')).toLowerCase()
  return q.toLowerCase().split(/\s+/).every(token => haystack.includes(token))
}

const actionResults = computed<PaletteAction[]>(() => {
  const q = query.value.trim()
  return allStaticActions.value.filter(a => fuzzyMatch(a, q)).slice(0, 8)
})

function close() {
  open.value = false
  query.value = ''
  activeIndex.value = 0
  tutorialResults.value = []
}

function show() {
  pageActions = buildStepActions()
  open.value = true
  nextTick(() => inputRef.value?.focus())
}

function move(delta: number) {
  const total = actionResults.value.length + tutorialResults.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + delta + total) % total
  scrollActiveIntoView()
}

function scrollActiveIntoView() {
  nextTick(() => {
    const el = listRef.value?.querySelector('.cmdk__item--active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function runActive() {
  const i = activeIndex.value
  if (i < actionResults.value.length) runItem(actionResults.value[i])
  else runItem(tutorialResults.value[i - actionResults.value.length])
}

function runItem(item: PaletteAction | undefined) {
  if (!item) return
  item.run(close)
}

function onBackdropClick() {
  close()
}

function onGlobalKeydown(e: KeyboardEvent) {
  // ⌘K / Ctrl+K — open. Allow re-toggle when already open (closes).
  const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')
  if (isCmdK) {
    e.preventDefault()
    if (open.value) close()
    else show()
  }
}

async function searchTutorials(term: string) {
  if (term.length < 2) {
    tutorialResults.value = []
    searching.value = false
    return
  }
  searching.value = true
  try {
    const params = new URLSearchParams()
    params.set('$search', term)
    params.set('$top', '6')
    params.set('$filter', "taskType eq 'TUTORIAL'")
    const res = await fetch(`/search/SearchableItems?${params}`)
    if (!res.ok) {
      tutorialResults.value = []
      return
    }
    const data = await res.json()
    tutorialResults.value = (data.value || [])
      .filter((row: { slug: string | null }) => row.slug)
      .map((row: { ID: string; title: string; slug: string; description: string | null; primaryTag: string | null; averageTimeToComplete: number | null }) => {
        const meta = [row.primaryTag, row.averageTimeToComplete ? `${row.averageTimeToComplete} min` : null].filter(Boolean).join(' · ')
        return {
          id: row.ID,
          label: row.title,
          hint: meta || undefined,
          icon: 'course-book',
          run: (close: () => void) => {
            close()
            window.location.href = `/tutorials/${row.slug}`
          },
        }
      })
  } catch {
    tutorialResults.value = []
  } finally {
    searching.value = false
  }
}

watch(query, (v) => {
  activeIndex.value = 0
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => searchTutorials(v.trim()), 200)
})

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  // Public hook so the shellbar (or any future entry point) can open without
  // synthesizing a keyboard event.
  ;(window as unknown as { openCommandPalette?: () => void }).openCommandPalette = show
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<style scoped>
/*
  Theming: every color is a Horizon CSS var so the palette tracks light/dark
  via the existing data-theme attribute on <html>. No overrides needed.
*/
.cmdk {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--sapBlockLayer_Background, rgba(0, 0, 0, 0.4));
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: clamp(2rem, 12vh, 8rem);
  animation: cmdk-fade 120ms ease-out;
}
@keyframes cmdk-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.cmdk__panel {
  width: min(640px, calc(100vw - 2rem));
  background: var(--sapGroup_ContentBackground, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapGroup_ContentBorderColor, var(--sapList_BorderColor));
  border-radius: 0.5rem;
  box-shadow: var(--sapContent_Shadow2, 0 4px 16px rgba(0, 0, 0, 0.2));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 560px);
}

.cmdk__input-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapShell_Background, transparent);
}
.cmdk__input-icon {
  font-size: 1rem;
  color: var(--sapContent_LabelColor);
  font-weight: 600;
}
.cmdk__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--sapTextColor);
  font: inherit;
  font-size: 0.9375rem;
  padding: 0.25rem 0;
}
.cmdk__input::placeholder { color: var(--sapContent_LabelColor); }

.cmdk__esc {
  font-family: inherit;
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
  background: var(--sapButton_Lite_Background, transparent);
  border: 1px solid var(--sapButton_Lite_BorderColor, var(--sapList_BorderColor));
  color: var(--sapContent_LabelColor);
}

.cmdk__list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
}
.cmdk__group-label {
  padding: 0.5rem 1rem 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--sapContent_LabelColor);
}

.cmdk__item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.5rem 1rem;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--sapList_TextColor, var(--sapTextColor));
}
.cmdk__item--active {
  background: var(--sapList_SelectionBackgroundColor, var(--sapList_Hover_Background));
  color: var(--sapList_Active_TextColor, var(--sapTextColor));
}
.cmdk__item-icon {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  color: var(--sapContent_NonInteractiveIconColor, var(--sapContent_LabelColor));
}
.cmdk__item-icon::before {
  /* SAP icon font: each icon name maps to a private-use codepoint. We don't
     ship the font here; ui5-bootstrap.ts already loads SAP icons globally and
     the ::before content lookup is handled by ui5-icon. For palette items we
     fall back to a leading dot if the font isn't available — readable, not
     pretty, but never broken. */
  content: "•";
}
.cmdk__item-label {
  font-size: 0.9375rem;
  color: inherit;
}
.cmdk__item-content {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  flex: 1;
  min-width: 0;
}
.cmdk__item-hint {
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmdk__empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--sapContent_LabelColor);
  font-size: 0.875rem;
}

.cmdk__footer {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--sapList_BorderColor);
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
  background: var(--sapShell_Background, transparent);
}
.cmdk__footer kbd {
  font-family: inherit;
  font-size: 0.6875rem;
  padding: 0.0625rem 0.375rem;
  margin-right: 0.25rem;
  border-radius: 0.25rem;
  background: var(--sapButton_Lite_Background, transparent);
  border: 1px solid var(--sapButton_Lite_BorderColor, var(--sapList_BorderColor));
  color: var(--sapContent_LabelColor);
}
</style>
