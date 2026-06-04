<!--
  hugo-apps/src/browse/BrowsePage.vue
  Root component for the /browse/ Vue island. Mounted on #browse-root via
  createApp (see main.ts).

  Architecture: Path C — Vue manages just the data-driven grid contents
  (#browse-root); plain DOM event listeners (controller.ts) wire the SSR'd
  controls (filter rail, sort dropdown, search input, pagination,
  rails fade-out) to the same useNavigatorFilters state this component
  reads. Avoids the byte-parity headache of full-page hydration.

  Why we drop BrowseFilterRail / BrowseRail / BrowseSortDropdown that the
  plan listed: they'd need to mirror Hugo's templates byte-for-byte for
  hydration to succeed, multiplying parity risk. The SSR'd HTML is the
  single source of truth for those regions; the controller mutates shared
  reactive state, the grid re-renders from it.

  Why <BrowsePage> renders just <BrowseGrid> with no wrapping element:
  the mount target #browse-root IS the grid container (<div class="browse-grid">).
  Wrapping in another element here would emit a stray <div> inside that
  container.

  Why createApp, not createSSRApp: BrowseGrid.vue uses <template v-for>
  as its root, which Vue represents as a fragment (Symbol(v-fgt)) in its
  render tree. SSR hydration would require fragment markers
  (<!--[-->/<!--]-->) bracketing each card in the SSR'd HTML; Hugo's flat
  partial output doesn't emit those, and shoehorning them in (or
  restructuring the grid to a single-element root) would push parity
  obligations onto the Hugo template that pre-PR-2 ergonomics doesn't
  justify. createApp accepts the trade: SSR'd cards are visible for the
  ~50-100ms before mount, then Vue replaces #browse-root's contents with
  its own render of the same data (read from the inline browse-data
  JSON, which carries the FULL catalog so pagination/sort/filter operate
  on every card, not just the first 24). The SSR pass still serves its
  primary purpose — no flash-of-empty-state, search-engine readable,
  works without JS.
-->
<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useNavigatorFilters } from '@shared/composables/useNavigatorFilters'
import { readSort, writeSort, DEFAULT_SORT, type Sort } from './browseUrl'
import { wireBrowseController } from './controller'
import { wireTracker } from '@shared/analytics/wire-tracker'
import BrowseGrid from './BrowseGrid.vue'
import { emptyProgress, toLookup, type ProgressPayload } from '../navigator/cardProgress'
import type { CardItem } from '@shared/types'

interface BrowseData {
  all: CardItem[]
  featured: string[]
  recent: string[]
  buildAt: string
}

const allCards = ref<CardItem[]>([])
const progress = ref<ProgressPayload>(emptyProgress())

// Read inlined catalog from <script id="browse-data" type="application/json">.
function readBrowseData(): BrowseData | null {
  if (typeof document === 'undefined') return null
  const el = document.getElementById('browse-data')
  if (!el?.textContent) return null
  try { return JSON.parse(el.textContent) as BrowseData } catch { return null }
}

const initialData = readBrowseData()
if (initialData?.all) allCards.value = initialData.all

// Destructure so the refs/computeds are top-level in <script setup> and
// Vue auto-unwraps them in the template. The full return object is also
// passed to the controller.
const filters = useNavigatorFilters({
  allCards,
  enableSort: true,
  syncURL: true,
  pageSize: 24,
})
const { displayedItems } = filters

// Sort param: read initial from URL, mirror into the composable, write back.
const sort = ref<Sort>(
  typeof window !== 'undefined' ? readSort(window.location.href) : DEFAULT_SORT
)
if (filters.sort) filters.sort.value = sort.value

watch(sort, (next) => {
  if (filters.sort) filters.sort.value = next
  if (typeof window !== 'undefined') {
    const newHref = writeSort(window.location.href, next)
    if (newHref !== window.location.href) {
      history.replaceState({}, '', newHref)
    }
  }
})

// Rails fade out when any filter or search is active. Controller toggles
// the [data-rails-hidden] attribute on the SSR'd container based on this.
const railsHidden = computed(() => filters.hasActiveFilters.value)

onMounted(async () => {
  // Best-effort progress fetch. 401 OK = anonymous user → empty progress.
  try {
    const res = await fetch('/build/my-progress', { credentials: 'include' })
    if (res.ok) {
      const json = await res.json()
      progress.value = toLookup(json)
    }
  } catch {
    // Network error — leave progress empty.
  }

  // Wire DOM event listeners for SSR'd controls (filter rail checkboxes,
  // sort dropdown, search input, pagination, clear-all, rails fade,
  // grid title count).
  wireBrowseController({ filters, sort, railsHidden })

  // Analytics tracker (#204) — fires page_view, filter_change, card_click,
  // pagination_change, rail_show_all_click, scroll_depth, page_leave.
  // Tracker self-disables on 503 (default until UI_EVENTS_ENABLED is set).
  wireTracker({ surface: '/browse/', filters })
})
</script>

<template>
  <BrowseGrid
    :items="displayedItems"
    :progress="progress"
  />
</template>
