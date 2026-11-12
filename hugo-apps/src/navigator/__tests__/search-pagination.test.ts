// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { computeTotalPages, useNavigatorFilters } from '../../shared/composables/useNavigatorFilters'
import * as useSearchModule from '../useSearch'
import type { TutorialEntry } from '@shared/types'

// ─── computeTotalPages unit tests ──────────────────────────────────────────

describe('computeTotalPages', () => {
  it('uses searchTotalCount when in search mode', () => {
    // 100 server-side results, 5 client-filtered items, pageSize 48 → 3 pages
    expect(computeTotalPages(true, 100, 5, 48)).toBe(3)
  })

  it('uses filteredLen when not in search mode', () => {
    // 5 client-filtered items, pageSize 48 → 1 page
    expect(computeTotalPages(false, 100, 5, 48)).toBe(1)
  })

  it('returns 0 pages when search mode total count is 0', () => {
    expect(computeTotalPages(true, 0, 0, 48)).toBe(0)
  })

  it('handles exact page boundary in search mode', () => {
    // exactly 48 → 1 page
    expect(computeTotalPages(true, 48, 0, 48)).toBe(1)
  })

  it('handles just-over boundary in search mode', () => {
    // 49 → 2 pages
    expect(computeTotalPages(true, 49, 0, 48)).toBe(2)
  })

  it('handles client mode with partial last page', () => {
    // 97 items, pageSize 48 → 3 pages
    expect(computeTotalPages(false, 0, 97, 48)).toBe(3)
  })
})

// ─── currentPage → executeSearch watcher: one-fetch-per-action guarantee ───
//
// Mocks useSearch so we can spy on executeSearch. The composable only
// enters server-search mode when: searchMode=true AND tutorials is provided
// AND !clientSearch. We match all three conditions below.

describe('search-mode pagination: one executeSearch per user action', () => {
  const tutorials = ref<TutorialEntry[]>([
    {
      slug: 'cap-intro', title: 'CAP Intro', description: '', time: 30,
      level: 'beginner', stepCount: 3, primaryTag: '',
      displayTags: [], displayTagSlugs: [], prev: null, next: null,
    },
  ])

  let executeSearchSpy: ReturnType<typeof vi.fn>
  let useSearchSpy: ReturnType<typeof vi.spyOn>

  // Build a mock useSearch that returns searchMode=true so the composable
  // takes the server-search path.
  function mountSearchComposable() {
    executeSearchSpy = vi.fn()
    useSearchSpy = vi.spyOn(useSearchModule, 'useSearch').mockReturnValue({
      searchMode: ref(true),
      isSubThreshold: ref(false),
      searchResults: ref([]),
      searchFacets: ref(null),
      searchTotalCount: ref(100),  // 100 results → 3 pages at pageSize 48
      isSearching: ref(false),
      searchError: ref(null),
      executeSearch: executeSearchSpy,
    } as unknown as ReturnType<typeof useSearchModule.useSearch>)

    return useNavigatorFilters({
      allCards: ref([]),
      tutorials,
      syncURL: false,
    })
  }

  afterEach(() => {
    useSearchSpy?.mockRestore()
  })

  it('scenario 3: filter change on page N>1 fires exactly one executeSearch (from debounce, not page watcher)', async () => {
    const f = mountSearchComposable()

    // Simulate user being on page 3 in search mode
    f.currentPage.value = 3
    await nextTick()
    // The watcher fires for this page change (page 1→3): that's a normal page navigation
    // We don't care about this call; reset the spy to count only the filter-change calls
    executeSearchSpy.mockClear()

    // Now change a filter — this should reset currentPage 3→1 and suppress the
    // page watcher fetch; the debounce (inside useSearch's own watcher) fires once.
    // However, since we've mocked useSearch entirely, the debounce doesn't run.
    // What we CAN assert: the page watcher does NOT fire an extra call when the
    // suppress flag is set by the reset watcher.
    f.filters.types = ['mission']
    await nextTick()
    await nextTick()  // flush any pending watchers

    // currentPage was reset to 1 by the reset watcher.
    expect(f.currentPage.value).toBe(1)

    // The page watcher must have consumed the suppress flag and NOT called
    // executeSearch for the 3→1 reset. (The debounce path is mocked away,
    // so total calls from the page watcher = 0 is the invariant here.)
    expect(executeSearchSpy).toHaveBeenCalledTimes(0)
  })

  it('scenario 4: user clicks page 2 — executeSearch called once with page index 1', async () => {
    const f = mountSearchComposable()
    executeSearchSpy.mockClear()

    f.currentPage.value = 2
    await nextTick()

    expect(executeSearchSpy).toHaveBeenCalledTimes(1)
    expect(executeSearchSpy).toHaveBeenCalledWith(1, 48)
  })

  it('scenario 5: user clicks pager page-1 button from page 3 — executeSearch called once with page index 0', async () => {
    const f = mountSearchComposable()

    // Navigate to page 3 first (without a filter change — no suppress flag)
    f.currentPage.value = 3
    await nextTick()
    executeSearchSpy.mockClear()

    // User clicks "page 1" via pager button: goToPage(1) sets currentPage=1
    // No filter changed, so suppress flag is NOT set.
    // The currentPage watcher should fire and fetch page 0.
    f.goToPage(1)
    await nextTick()

    expect(executeSearchSpy).toHaveBeenCalledTimes(1)
    expect(executeSearchSpy).toHaveBeenCalledWith(0, 48)
  })

  it('scenario 2: filter change on page 1 — page watcher silent (no value change), zero extra calls', async () => {
    const f = mountSearchComposable()
    // Page is already 1 (default)
    executeSearchSpy.mockClear()

    f.filters.types = ['group']
    await nextTick()
    await nextTick()

    // currentPage stays at 1 — no change, no page watcher fire
    expect(f.currentPage.value).toBe(1)
    expect(executeSearchSpy).toHaveBeenCalledTimes(0)
  })
})
