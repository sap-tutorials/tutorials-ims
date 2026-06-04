<!--
  hugo-apps/src/browse/BrowsePage.vue
  Root component for the /browse/ Vue island. Mounted on #browse-root via
  createSSRApp.

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
  container and break hydration. createSSRApp accepts a fragment root.
-->
<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useNavigatorFilters } from '@shared/composables/useNavigatorFilters'
import { readSort, writeSort, DEFAULT_SORT, type Sort } from './browseUrl'
import { wireBrowseController } from './controller'
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
})
</script>

<template>
  <BrowseGrid
    :items="displayedItems"
    :progress="progress"
  />
</template>
