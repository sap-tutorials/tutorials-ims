// hugo-apps/src/shared/analytics/filter-events.ts
//
// Wires filter_change events for the navigator's reactive filter state.
// Receives the return value of useNavigatorFilters(...) and sets up Vue
// watchers that fire `track('filter_change', ...)` on each mutation.
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

import { watch, type WatchStopHandle, type Ref } from 'vue'

import { track } from './tracker'

interface FiltersShape {
  searchQuery: Ref<string>
  filters: {
    levels: string[]
    types: string[]
    products: string[]
    topics: string[]
    isNew: boolean
    noLicense: boolean
  }
  sort?: Ref<string>
}

interface WireFilterEventsOpts {
  filters: FiltersShape
  surface: string
}

let stopHandles: WatchStopHandle[] = []
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

export function wireFilterEvents(opts: WireFilterEventsOpts) {
  const { filters } = opts

  // NOTE: Vue's default `watch()` does NOT fire on initial mount (no
  // `immediate: true`), so the first invocation of each handler corresponds
  // to the first real mutation. No skip-first guard needed.

  // Search — debounced 500ms
  stopHandles.push(
    watch(filters.searchQuery, (newVal) => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      searchDebounceTimer = setTimeout(() => {
        track('filter_change', { kind: 'search', value: newVal })
      }, 500)
    })
  )

  // Multi-select arrays — fire on every change with new value
  for (const [key, kind] of [
    ['levels', 'level'],
    ['types', 'type'],
    ['products', 'product'],
    ['topics', 'topic'],
  ] as const) {
    stopHandles.push(
      watch(
        () => [...filters.filters[key]],
        (newVal) => {
          track('filter_change', { kind, value: newVal })
        },
        { deep: true }
      )
    )
  }

  // Quick filters — fire only on toggle-on
  stopHandles.push(
    watch(
      () => filters.filters.isNew,
      (newVal) => {
        if (newVal) track('filter_change', { kind: 'quick-new' })
      }
    )
  )
  stopHandles.push(
    watch(
      () => filters.filters.noLicense,
      (newVal) => {
        if (newVal) track('filter_change', { kind: 'quick-noLicense' })
      }
    )
  )

  // Sort — only if present
  if (filters.sort) {
    stopHandles.push(
      watch(
        filters.sort,
        (newVal) => {
          track('filter_change', { kind: 'sort', value: newVal })
        }
      )
    )
  }
}

export function _resetForTests() {
  for (const stop of stopHandles) {
    try { stop() } catch { /* noop */ }
  }
  stopHandles = []
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
}
