<!-- hugo-apps/src/related-graph/ExpandedPanel.vue
     Task 12 of KG widget redesign (#850). Joule-style right-side dialog:
     - Teleports into #kg-expanded-root (added by Task 15 to the Hugo tutorial
       object-page layout).
     - Fetches /graph/neighborhoodFull(slug='...') lazily on mount unless a
       `data` prop is supplied (the test path).
     - Renders skeleton during load, retry state on error.
     - Full-width Prerequisites at top → 2-column grid of per-type <details>
       (priority order) → Shared concepts + What to learn next at bottom.
     - Empty per-type buckets are omitted; a fully empty otherResourcesByType
       shows one subdued line.
     - ⤢ widens (data-wide attribute), ✕/ESC close.
     - Emits telemetry: kg.expanded.opened, .closed (dwellMs), .widened,
       .click, .section_toggled.
-->
<template>
  <Teleport to="#kg-expanded-root">
    <div
      class="kg-expanded"
      :data-wide="wide ? 'true' : 'false'"
      role="dialog"
      aria-modal="false"
      aria-labelledby="kg-expanded-title"
      tabindex="-1"
      ref="dialogEl"
      @keydown.esc="onClose"
    >
      <header class="kg-expanded__header">
        <div class="kg-expanded__titles">
          <h2 id="kg-expanded-title" class="kg-expanded__title">Related learning — deep dive</h2>
          <p class="kg-expanded__subtitle">From {{ tutorialTitle }}</p>
        </div>
        <div class="kg-expanded__actions">
          <button
            type="button"
            class="kg-expanded__widen"
            :aria-label="wide ? 'Narrow' : 'Widen'"
            @click="toggleWide"
          >⤢</button>
          <button
            type="button"
            class="kg-expanded__close"
            aria-label="Close"
            @click="onClose"
          >✕</button>
        </div>
      </header>

      <div class="kg-expanded__body">
        <template v-if="displayData">
          <!-- Prerequisites full-width -->
          <section v-if="displayData.prerequisitesOf.length" class="kg-expanded__prereq">
            <h3>Prerequisites you might want first</h3>
            <ul>
              <li v-for="t in displayData.prerequisitesOf" :key="t.slug">
                <a :href="`/tutorials/${t.slug}/`">{{ t.title || t.slug }}</a>
                <span v-if="t.reason" class="kg-expanded__reason"> — {{ t.reason }}</span>
              </li>
            </ul>
          </section>

          <!-- Per-type grid -->
          <div v-if="displayData.otherResourcesByType.length" class="kg-expanded__grid">
            <details
              v-for="entry in displayData.otherResourcesByType"
              :key="entry.type"
              open
              class="kg-expanded__section"
              @toggle="onSectionToggle($event, entry.type)"
            >
              <summary>{{ entry.config.icon }} {{ entry.config.plural }} · {{ entry.items.length }}</summary>
              <ul class="kg-expanded__section-list">
                <ResourceRow
                  v-for="row in entry.items"
                  :key="row.slug"
                  :config="entry.config"
                  :row="row"
                  @click="onRowClick(entry.type, $event)"
                />
              </ul>
            </details>
          </div>
          <p v-else class="kg-expanded__no-resources">
            No external resources are linked to this tutorial's concepts yet.
          </p>

          <!-- Shared concepts + Next tutorials full-width -->
          <section v-if="displayData.sharedConcepts.length" class="kg-expanded__shared">
            <h3>Tutorials covering related concepts</h3>
            <ul>
              <li v-for="t in displayData.sharedConcepts" :key="t.slug">
                <a :href="`/tutorials/${t.slug}/`">{{ t.title || t.slug }}</a>
              </li>
            </ul>
          </section>

          <section v-if="displayData.whatToLearnNext.length" class="kg-expanded__next">
            <h3>What to learn next</h3>
            <ul>
              <li v-for="t in displayData.whatToLearnNext" :key="t.slug">
                <a :href="`/tutorials/${t.slug}/`">{{ t.title || t.slug }}</a>
              </li>
            </ul>
          </section>
        </template>

        <div v-else-if="loadError" class="kg-expanded__error">
          <p>Couldn't load the deep dive.</p>
          <button type="button" class="kg-expanded__retry" @click="loadData">Try again</button>
        </div>

        <div
          v-else
          class="kg-expanded__skeleton"
          aria-busy="true"
          aria-label="Loading related learning"
        >
          <div class="skeleton skeleton--text-line"></div>
          <div class="skeleton skeleton--text-line"></div>
          <div class="skeleton skeleton--text-line"></div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { NeighborhoodFullResult, OtherResource } from './types';
import ResourceRow from './ResourceRow.vue';

const props = defineProps<{
  slug: string;
  tutorialTitle: string;
  data?: NeighborhoodFullResult | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const wide = ref(false);
const dialogEl = ref<HTMLElement | null>(null);
const fetchedData = ref<NeighborhoodFullResult | null | undefined>(undefined);
const loadError = ref(false);
// Track section-toggled events emitted synchronously by <details open>
// on first mount so we can suppress the initial noise. Vue does NOT fire
// toggle events on initial render in the browser, but JSDOM/happy-dom can
// dispatch them when we set `open` in tests — the flag also guards against
// a Vue implementation shift.
const mountedAt = Date.now();
const suppressToggleUntilMounted = ref(true);

const displayData = computed<NeighborhoodFullResult | null>(() => {
  // props.data === null means the caller explicitly said "no data / error"
  // props.data === undefined means the panel should fetch (or use fetched)
  if (props.data === null) return null;
  if (props.data !== undefined) return props.data;
  return fetchedData.value ?? null;
});

function emitEvent(type: string, detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // never let telemetry break the dialog
  }
}

function toggleWide(): void {
  wide.value = !wide.value;
  emitEvent('kg.expanded.widened', { slug: props.slug, wider: wide.value });
}

function onClose(): void {
  emitEvent('kg.expanded.closed', {
    slug: props.slug,
    dwellMs: Date.now() - mountedAt,
  });
  emit('close');
}

function onRowClick(resourceType: string, row: OtherResource): void {
  emitEvent('kg.expanded.click', {
    slug: props.slug,
    resourceType,
    targetSlug: row.slug,
    source: 'expanded',
  });
}

function onSectionToggle(evt: Event, resourceType: string): void {
  if (suppressToggleUntilMounted.value) return;
  const target = evt.target as HTMLDetailsElement;
  emitEvent('kg.expanded.section_toggled', {
    slug: props.slug,
    resourceType,
    open: target.open,
  });
}

async function loadData(): Promise<void> {
  loadError.value = false;
  fetchedData.value = undefined;
  try {
    const res = await fetch(
      `/graph/neighborhoodFull(slug='${encodeURIComponent(props.slug)}')`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fetchedData.value = (await res.json()) as NeighborhoodFullResult;
  } catch {
    loadError.value = true;
    fetchedData.value = null;
  }
}

onMounted(async () => {
  emitEvent('kg.expanded.opened', { slug: props.slug });
  // Focus the close button for keyboard users. requestAnimationFrame may be
  // undefined in some test environments; guard defensively.
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  raf(() => {
    const closeBtn = document.querySelector<HTMLElement>('.kg-expanded__close');
    closeBtn?.focus();
    // Now allow user-driven <details> toggles to emit telemetry.
    suppressToggleUntilMounted.value = false;
  });
  // Fallback: if raf never fires (edge case), still lift the suppression
  // after a microtask.
  Promise.resolve().then(() => {
    suppressToggleUntilMounted.value = false;
  });
  if (props.data === undefined) {
    await loadData();
  }
});
</script>

<style scoped>
/* Task 14 will supply the full stylesheet. Minimal skeleton here so class
   hooks exist for tests + local dev preview. */
.kg-expanded {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(480px, 100vw);
  background: var(--sapBackgroundColor, #fff);
  border-left: 1px solid var(--sapGroup_ContentBorderColor, #d5dadf);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  transition: width 0.2s ease;
}

.kg-expanded[data-wide='true'] {
  width: min(720px, 100vw);
}

.kg-expanded__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--sapGroup_ContentBorderColor, #eaecee);
}

.kg-expanded__title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
}

.kg-expanded__subtitle {
  margin: 0.125rem 0 0;
  font-size: 0.85rem;
  color: var(--sapContent_LabelColor, #556b82);
}

.kg-expanded__actions {
  display: flex;
  gap: 0.25rem;
}

.kg-expanded__widen,
.kg-expanded__close {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  font-size: 1rem;
  line-height: 1;
  color: var(--sapContent_LabelColor, #556b82);
}

.kg-expanded__widen:hover,
.kg-expanded__close:hover,
.kg-expanded__widen:focus,
.kg-expanded__close:focus {
  background: var(--sapButton_Hover_Background, #eaecee);
  outline: none;
}

.kg-expanded__body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.kg-expanded__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 720px) {
  .kg-expanded[data-wide='true'] .kg-expanded__grid {
    grid-template-columns: 1fr 1fr;
  }
}

.kg-expanded__section {
  border: 1px solid var(--sapGroup_ContentBorderColor, #eaecee);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.kg-expanded__section summary {
  cursor: pointer;
  font-weight: 600;
  padding: 0.25rem 0;
}

.kg-expanded__section-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
}

.kg-expanded__no-resources {
  color: var(--sapContent_LabelColor, #556b82);
  font-style: italic;
  margin: 0;
}

.kg-expanded__skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.kg-expanded__error {
  color: var(--sapContent_LabelColor, #556b82);
}

.kg-expanded__retry {
  margin-top: 0.5rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--sapButton_BorderColor, #556b82);
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
}
</style>
