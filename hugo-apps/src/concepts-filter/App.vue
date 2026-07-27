<!-- hugo-apps/src/concepts-filter/App.vue -->
<!--
  Concepts filter island (#859, virtualized in #1327 Task 4).

  The CAP-served /concepts/ list page (srv/lib/concept-list-page.js) emits
  the top-100 concepts as SSR <li> (SEO / no-JS) plus the FULL slim array in
  a `<script type="application/json" id="concepts-data">` block. This island
  reads that JSON and renders only the visible slice via vue-virtual-scroller's
  RecycleScroller — so a 5k-10k concept corpus stays a few dozen live DOM nodes
  instead of thousands, and each keystroke filters an in-memory array (<5ms)
  instead of walking the DOM.

  Progressive enhancement: without JS the SSR top-100 + <noscript> A-Z remain
  usable. Backward-compatible: if there is no #concepts-data (e.g. the legacy
  Hugo-static page before the Task 5 route flip), the island falls back to
  reading the SSR <li> data-* attributes, the pre-#1327 behavior.

  URL sync is bidirectional (history.replaceState on change, read on popstate).
-->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { RecycleScroller } from 'vue-virtual-scroller';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';
import ConceptCard from './ConceptCard.vue';
import {
  applyFilters,
  availableLetters,
  fromQueryString,
  toQueryString,
  DEFAULT_STATE,
  type ConceptCard as ConceptCardT,
  type FilterState,
  type SortKey,
} from './filter-logic';

// Fixed card height (px) for the virtual scroller. Pinned (not measured) — a
// constant primary item size is the single biggest perf win on RecycleScroller.
// Must accommodate name + truncated description + meta line.
const ITEM_SIZE = 140;
// Minimum card width — mirrors the SSR grid's `minmax(280px, 1fr)` so the
// windowed grid reflows to the same column count as the no-JS card grid.
const MIN_COL_WIDTH = 280;
const GRID_GAP = 12; // px, matches the SSR `.concepts-index__list` 0.75rem gap

const cards = ref<ConceptCardT[]>([]);
const state = ref<FilterState>({ ...DEFAULT_STATE });
const listEl = ref<HTMLElement | null>(null);
let countEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;

// Responsive grid geometry — recomputed on mount + container resize so the
// RecycleScroller renders the SAME multi-column card grid as PROD (issue
// #1327: virtualization AND the responsive grid, not one or the other).
const gridItems = ref(1);       // columns per row
const colWidth = ref(MIN_COL_WIDTH); // px, drives RecycleScroller itemSecondarySize
let resizeObserver: ResizeObserver | null = null;

function recomputeGrid() {
  const w = listEl.value?.clientWidth ?? 0;
  if (w <= 0) { gridItems.value = 1; colWidth.value = MIN_COL_WIDTH; return; }
  // How many min-width columns (+gap) fit; at least 1.
  const cols = Math.max(1, Math.floor((w + GRID_GAP) / (MIN_COL_WIDTH + GRID_GAP)));
  gridItems.value = cols;
  // Distribute full width across the columns (like `1fr`), accounting for gaps.
  colWidth.value = Math.floor((w - GRID_GAP * (cols - 1)) / cols);
}

// Debounce query input so typing "cloud" doesn't refilter five times.
let queryDebounce: ReturnType<typeof setTimeout> | null = null;
const queryInput = ref('');
function onQueryInput(evt: Event) {
  queryInput.value = (evt.target as HTMLInputElement).value;
  if (queryDebounce) clearTimeout(queryDebounce);
  queryDebounce = setTimeout(() => {
    state.value = { ...state.value, query: queryInput.value };
  }, 100);
}

function setLetter(letter: string | null) { state.value = { ...state.value, letter }; }
function setSort(sort: SortKey) { state.value = { ...state.value, sort }; }
function clearAll() {
  state.value = { ...DEFAULT_STATE };
  queryInput.value = '';
}

// The filtered + sorted array the scroller renders.
const visible = computed(() => applyFilters(cards.value, state.value));
const availLetters = computed(() => availableLetters(cards.value, state.value));

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat('#');

function normaliseLetter(raw: string): string {
  const c = (raw || '').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

// Read the embedded JSON array, or fall back to the SSR <li> data-* attrs.
function loadCards(): ConceptCardT[] {
  const dataEl = document.getElementById('concepts-data');
  if (dataEl?.textContent) {
    try {
      const parsed = JSON.parse(dataEl.textContent) as ConceptCardT[];
      if (Array.isArray(parsed)) {
        return parsed
          .filter((c) => c && typeof c.slug === 'string' && c.slug)
          .map((c) => ({
            slug: c.slug,
            name: c.name ?? '',
            description: c.description ?? '',
            firstLetter: normaliseLetter(c.firstLetter ?? c.name ?? ''),
            tutorialCount: Number(c.tutorialCount) || 0,
          }));
      }
    } catch {
      // fall through to DOM index
    }
  }
  // Fallback: legacy Hugo-static page — read the SSR <li> attributes.
  const items = listEl.value
    ? Array.from(listEl.value.querySelectorAll<HTMLElement>('.concepts-index__item'))
    : [];
  return items
    .map((li) => ({
      slug: li.dataset.slug ?? '',
      name: li.dataset.name ?? '',
      description: li.dataset.description ?? '',
      firstLetter: normaliseLetter(li.dataset.firstLetter ?? ''),
      tutorialCount: Number.parseInt(li.dataset.tutorialCount ?? '0', 10) || 0,
    }))
    .filter((c) => c.slug);
}

// Keep the count line + empty-state banner in sync (elements Hugo/CAP emit).
function syncChrome() {
  if (countEl) {
    const n = visible.value.length;
    const total = cards.value.length;
    countEl.textContent = n === total
      ? `${total} concept${total === 1 ? '' : 's'}`
      : `${n} of ${total} concept${total === 1 ? '' : 's'}`;
  }
  if (emptyEl) {
    if (visible.value.length === 0) emptyEl.removeAttribute('hidden');
    else emptyEl.setAttribute('hidden', '');
  }
}

function writeUrl() {
  const qs = toQueryString(state.value);
  window.history.replaceState({}, '', `${window.location.pathname}${qs}${window.location.hash}`);
}
function readUrl() {
  const parsed = fromQueryString(window.location.search.replace(/^\?/, ''));
  queryInput.value = parsed.query;
  state.value = parsed;
}
function onPopState() { readUrl(); }

onMounted(() => {
  countEl = document.getElementById('concepts-filter-count');
  listEl.value = document.getElementById('concepts-filter-list');
  emptyEl = document.getElementById('concepts-filter-empty');
  const clearBtn = document.getElementById('concepts-filter-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearAll);

  cards.value = loadCards();

  // Clear the SSR top-100 <li> — the scroller owns the list DOM now. (No-op
  // when the list came from JSON with an empty <ul>.)
  if (listEl.value) {
    for (const li of Array.from(listEl.value.querySelectorAll('.concepts-index__item'))) {
      li.remove();
    }
  }

  readUrl();
  window.addEventListener('popstate', onPopState);
  syncChrome();

  // Responsive grid: size columns to the container now + on every resize so
  // the virtual grid reflows exactly like the SSR minmax(280px,1fr) grid.
  recomputeGrid();
  if (listEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => recomputeGrid());
    resizeObserver.observe(listEl.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState);
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
});

watch([visible, cards], syncChrome);
watch(state, writeUrl);
</script>

<template>
  <div class="concepts-filter">
    <div class="concepts-filter__row">
      <label class="concepts-filter__label" for="concepts-filter-q">Search concepts</label>
      <input
        id="concepts-filter-q"
        type="search"
        class="concepts-filter__input"
        :value="queryInput"
        @input="onQueryInput"
        placeholder="e.g. CAP, HANA, Fiori"
        autocomplete="off"
        spellcheck="false"
      />
      <label class="concepts-filter__label" for="concepts-filter-sort">Sort</label>
      <select
        id="concepts-filter-sort"
        class="concepts-filter__select"
        :value="state.sort"
        @change="setSort(($event.target as HTMLSelectElement).value as SortKey)"
      >
        <option value="name">Alphabetical</option>
        <option value="coverage">Most tutorials</option>
      </select>
      <button
        v-if="state.query || state.letter || state.sort !== 'name'"
        type="button"
        class="concepts-filter__clear"
        @click="clearAll"
      >Clear all</button>
    </div>
    <nav class="concepts-filter__alpha" aria-label="Jump to letter">
      <button
        type="button"
        :class="['concepts-filter__alpha-btn', { 'is-active': state.letter === null }]"
        @click="setLetter(null)"
      >All</button>
      <button
        v-for="ch in alphabet"
        :key="ch"
        type="button"
        :class="[
          'concepts-filter__alpha-btn',
          {
            'is-active': state.letter === ch,
            'is-disabled': !availLetters.has(ch),
          },
        ]"
        :disabled="!availLetters.has(ch)"
        @click="setLetter(ch)"
      >{{ ch }}</button>
    </nav>
  </div>

  <!-- Render the virtualized list into the existing #concepts-filter-list
       container the page already lays out. RecycleScroller GRID mode
       (gridItems columns × itemSecondarySize width) reproduces PROD's
       responsive multi-column card grid while keeping only the visible
       window live in the DOM — #1327: virtualization AND the grid. -->
  <Teleport v-if="listEl" :to="listEl">
    <RecycleScroller
      class="concepts-index__scroller"
      :items="visible"
      :item-size="ITEM_SIZE"
      :grid-items="gridItems"
      :item-secondary-size="colWidth"
      key-field="slug"
      v-slot="{ item }"
    >
      <ConceptCard :card="item" />
    </RecycleScroller>
  </Teleport>
</template>

<style scoped>
/* Theme-aware — colors read from the SAP Horizon CSS variables declared in
   hugo/assets/css/sap-theme-vars.css, with light-mode hex as var() fallback
   (dark-on-dark fix #1169). */
.concepts-filter {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  margin-bottom: 1rem;
  background: var(--sapNeutralBackground, #f5f6f7);
  border-radius: 6px;
}
.concepts-filter__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: center;
}
.concepts-filter__label {
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #515559);
  font-weight: 500;
}
.concepts-filter__input {
  flex: 1 1 240px;
  min-width: 12rem;
  padding: 0.4rem 0.6rem;
  font: inherit;
  border: 1px solid var(--sapField_BorderColor, #d5dadc);
  border-radius: 4px;
  background: var(--sapField_Background, #fff);
  color: var(--sapField_TextColor, #32363a);
}
.concepts-filter__input::placeholder {
  color: var(--sapContent_LabelColor, #515559);
}
.concepts-filter__input:focus {
  outline: 2px solid var(--sapBrandColor, #0070f2);
  outline-offset: 1px;
}
.concepts-filter__select {
  padding: 0.4rem 0.5rem;
  font: inherit;
  border: 1px solid var(--sapField_BorderColor, #d5dadc);
  border-radius: 4px;
  background: var(--sapField_Background, #fff);
  color: var(--sapField_TextColor, #32363a);
}
.concepts-filter__clear {
  padding: 0.4rem 0.7rem;
  font: inherit;
  font-size: 0.875rem;
  border: 1px solid var(--sapField_BorderColor, #d5dadc);
  border-radius: 4px;
  background: var(--sapButton_Background, #fff);
  color: var(--sapLinkColor, #0070f2);
  cursor: pointer;
}
.concepts-filter__clear:hover {
  border-color: var(--sapBrandColor, #0070f2);
}
.concepts-filter__alpha {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.concepts-filter__alpha-btn {
  min-width: 1.75rem;
  padding: 0.25rem 0.4rem;
  font: inherit;
  font-size: 0.8125rem;
  border: 1px solid var(--sapField_BorderColor, #d5dadc);
  border-radius: 3px;
  background: var(--sapButton_Background, #fff);
  color: var(--sapTextColor, #1d2d3e);
  cursor: pointer;
}
.concepts-filter__alpha-btn:hover:not(.is-disabled) {
  border-color: var(--sapBrandColor, #0070f2);
}
.concepts-filter__alpha-btn.is-active {
  background: var(--sapButton_Emphasized_Background, #0070f2);
  border-color: var(--sapButton_Emphasized_BorderColor, #0070f2);
  color: var(--sapButton_Emphasized_TextColor, #fff);
}
.concepts-filter__alpha-btn.is-disabled {
  color: var(--sapContent_DisabledTextColor, #a4a7ab);
  background: var(--sapNeutralBackground, #f8f9fa);
  cursor: not-allowed;
}
</style>

<style>
/* Unscoped: the virtual scroller is teleported into #concepts-filter-list
   (outside this component's scope), so these rules are global. */

/* Once the island mounts and teleports the scroller in, the <ul> no longer
   lays out cards itself — RecycleScroller grid mode owns columns. Drop the
   SSR `display:grid` on the container so it doesn't fight the scroller's
   internal absolute positioning. `:has()` scopes this to the JS-hydrated
   state only; the no-JS SSR grid (no scroller child) is untouched. */
.concepts-index__list:has(.concepts-index__scroller) {
  display: block;
}
.concepts-index__scroller {
  height: 70vh;
  min-height: 320px;
  overflow-y: auto;
}
/* Recycled cards fill their grid cell (RecycleScroller sizes the cell via
   itemSecondarySize; the item stretches to it). */
.concepts-index__scroller .vue-recycle-scroller__item-view > .concepts-index__item {
  height: 100%;
  box-sizing: border-box;
}
</style>
