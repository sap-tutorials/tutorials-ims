<!-- hugo-apps/src/concepts-filter/App.vue -->
<!--
  Concepts filter island (#859).

  The Hugo grid at /concepts/ is fully static — every card is a
  server-rendered <li> with data-* attributes carrying slug, name,
  description, first-letter, tutorial-count. This island reads those
  attributes into an in-memory index once on mount, then filters the
  DOM (via the `hidden` attribute on each <li>) as the user types /
  clicks A-Z / changes sort.

  Progressive enhancement: without this island the static grid is fully
  usable (just no search). The island's controls slot into the existing
  #concepts-filter-controls container which Hugo hides by default.

  URL sync is bidirectional: the URL is updated with `history.replaceState`
  as the user types, and reflected back into filter state on page load
  or browser Back/Forward. Matches the navigator's urlSync pattern.
-->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import {
  applyFilters,
  availableLetters,
  fromQueryString,
  toQueryString,
  DEFAULT_STATE,
  type ConceptCard,
  type FilterState,
  type SortKey,
} from './filter-logic';

const cards = ref<ConceptCard[]>([]);
const state = ref<FilterState>({ ...DEFAULT_STATE });
// The `_index.md` count element ("N concepts") so we can update it after
// filtering. Left null when the island isn't mounted (grid empty).
let countEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;

// Debounce for query input so typing "cloud" doesn't do five filter
// passes in a row. 100ms feels responsive but avoids layout thrash on
// large grids.
let queryDebounce: ReturnType<typeof setTimeout> | null = null;
const queryInput = ref('');
function onQueryInput(evt: Event) {
  queryInput.value = (evt.target as HTMLInputElement).value;
  if (queryDebounce) clearTimeout(queryDebounce);
  queryDebounce = setTimeout(() => {
    state.value = { ...state.value, query: queryInput.value };
  }, 100);
}

function setLetter(letter: string | null) {
  state.value = { ...state.value, letter };
}

function setSort(sort: SortKey) {
  state.value = { ...state.value, sort };
}

function clearAll() {
  state.value = { ...DEFAULT_STATE };
  queryInput.value = '';
}

// Compute the visible slugs and hide/show cards + reorder them.
const visibleSlugs = computed(() => new Set(applyFilters(cards.value, state.value).map((c) => c.slug)));
const availLetters = computed(() => availableLetters(cards.value, state.value));

// The alphabet strip. '#' is a bucket for non-alpha starts (numbers,
// symbols). Always rendered so its width doesn't jump as letters come
// and go, but disabled buttons look muted.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat('#');

function applyToDom() {
  if (!listEl) return;

  // The pure-function order is our target render order — reorder DOM
  // to match. This keeps the visual list in sync with the sort control.
  const ordered = applyFilters(cards.value, state.value);
  const bySlug = new Map<string, HTMLElement>();
  for (const li of listEl.children) {
    const slug = (li as HTMLElement).dataset.slug;
    if (slug) bySlug.set(slug, li as HTMLElement);
  }
  // Reorder: appendChild moves the node without cloning.
  for (const c of ordered) {
    const li = bySlug.get(c.slug);
    if (li) listEl.appendChild(li);
  }
  // Hide the ones that filtered out.
  const visible = new Set(ordered.map((c) => c.slug));
  for (const [slug, li] of bySlug) {
    if (visible.has(slug)) {
      li.removeAttribute('hidden');
    } else {
      li.setAttribute('hidden', '');
    }
  }
  // Update the count line + empty-state banner.
  if (countEl) {
    const n = ordered.length;
    const total = cards.value.length;
    if (n === total) {
      countEl.textContent = `${total} concept${total === 1 ? '' : 's'}`;
    } else {
      countEl.textContent = `${n} of ${total} concept${total === 1 ? '' : 's'}`;
    }
  }
  if (emptyEl) {
    if (ordered.length === 0) emptyEl.removeAttribute('hidden');
    else emptyEl.setAttribute('hidden', '');
  }
}

// URL sync — write on state change, no reload; read on popstate.
function writeUrl() {
  const qs = toQueryString(state.value);
  // Preserve any hash fragment (concept anchors, etc.).
  const url = `${window.location.pathname}${qs}${window.location.hash}`;
  window.history.replaceState({}, '', url);
}
function readUrl() {
  const parsed = fromQueryString(window.location.search.replace(/^\?/, ''));
  queryInput.value = parsed.query;
  state.value = parsed;
}
function onPopState() { readUrl(); }

onMounted(() => {
  countEl = document.getElementById('concepts-filter-count');
  listEl = document.getElementById('concepts-filter-list');
  emptyEl = document.getElementById('concepts-filter-empty');
  const clearBtn = document.getElementById('concepts-filter-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearAll);

  if (!listEl) return; // Grid is empty — bail; the static empty-state is fine.

  // Build the in-memory index from data-* attributes on each <li>.
  const items = Array.from(listEl.querySelectorAll<HTMLElement>('.concepts-index__item'));
  const parsed: ConceptCard[] = items.map((li) => ({
    slug: li.dataset.slug ?? '',
    name: li.dataset.name ?? '',
    description: li.dataset.description ?? '',
    firstLetter: normaliseLetter(li.dataset.firstLetter ?? ''),
    tutorialCount: Number.parseInt(li.dataset.tutorialCount ?? '0', 10) || 0,
  })).filter((c) => c.slug);
  cards.value = parsed;

  readUrl();
  window.addEventListener('popstate', onPopState);
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState);
});

watch(state, () => {
  applyToDom();
  writeUrl();
});

function normaliseLetter(raw: string): string {
  // 'CAP' → 'C', ' ' → '#', '3' → '#'. Data attribute is uppercased by
  // Hugo but be defensive.
  const c = (raw || '').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}
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
</template>

<style scoped>
.concepts-filter {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  margin-bottom: 1rem;
  background: #f5f6f7;
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
  color: #515559;
  font-weight: 500;
}
.concepts-filter__input {
  flex: 1 1 240px;
  min-width: 12rem;
  padding: 0.4rem 0.6rem;
  font: inherit;
  border: 1px solid #d5dadc;
  border-radius: 4px;
  background: #fff;
}
.concepts-filter__input:focus {
  outline: 2px solid #0070f2;
  outline-offset: 1px;
}
.concepts-filter__select {
  padding: 0.4rem 0.5rem;
  font: inherit;
  border: 1px solid #d5dadc;
  border-radius: 4px;
  background: #fff;
}
.concepts-filter__clear {
  padding: 0.4rem 0.7rem;
  font: inherit;
  font-size: 0.875rem;
  border: 1px solid #d5dadc;
  border-radius: 4px;
  background: #fff;
  color: #0070f2;
  cursor: pointer;
}
.concepts-filter__clear:hover {
  border-color: #0070f2;
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
  border: 1px solid #d5dadc;
  border-radius: 3px;
  background: #fff;
  color: #1d2d3e;
  cursor: pointer;
}
.concepts-filter__alpha-btn:hover:not(.is-disabled) {
  border-color: #0070f2;
}
.concepts-filter__alpha-btn.is-active {
  background: #0070f2;
  border-color: #0070f2;
  color: #fff;
}
.concepts-filter__alpha-btn.is-disabled {
  color: #a4a7ab;
  background: #f8f9fa;
  cursor: not-allowed;
}
</style>
