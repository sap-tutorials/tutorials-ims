// hugo-apps/src/shared/analytics/__tests__/filter-events.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, reactive, nextTick } from 'vue'

vi.mock('../tracker', () => ({
  track: vi.fn(),
  flush: vi.fn(),
}))

import { track } from '../tracker'
import { wireFilterEvents, _resetForTests } from '../filter-events'

function makeFilters(opts: { withSort?: boolean } = {}) {
  return {
    searchQuery: ref(''),
    filters: reactive({
      levels: [] as string[],
      types: [] as string[],
      products: [] as string[],
      topics: [] as string[],
      isNew: false,
      noLicense: false,
    }),
    ...(opts.withSort ? { sort: ref('newest') } : {}),
  }
}

describe('filter-events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    _resetForTests()
  })
  afterEach(() => {
    _resetForTests()
    vi.useRealTimers()
  })

  it('does not fire any filter_change on initial mount', async () => {
    const filters = makeFilters({ withSort: true })
    wireFilterEvents({ filters, surface: '/browse/' })
    await nextTick()
    expect(track).not.toHaveBeenCalled()
  })

  it('fires filter_change with kind:"level" when levels array changes', async () => {
    const filters = makeFilters()
    wireFilterEvents({ filters, surface: '/browse/' })
    await nextTick()
    filters.filters.levels.push('beginner')
    await nextTick()
    expect(track).toHaveBeenCalledWith('filter_change', { kind: 'level', value: ['beginner'] })
  })

  it('fires filter_change with kind:"search" once after 500ms debounce', async () => {
    const filters = makeFilters()
    wireFilterEvents({ filters, surface: '/browse/' })
    await nextTick()
    filters.searchQuery.value = 'a'
    await nextTick()
    filters.searchQuery.value = 'ab'
    await nextTick()
    filters.searchQuery.value = 'abc'
    await nextTick()
    // Before debounce window — not fired yet
    expect(track).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('filter_change', { kind: 'search', value: 'abc' })
  })

  it('fires kind:"quick-new" only when isNew toggles ON, not OFF', async () => {
    const filters = makeFilters()
    wireFilterEvents({ filters, surface: '/browse/' })
    await nextTick()
    filters.filters.isNew = true
    await nextTick()
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('filter_change', { kind: 'quick-new' })
    vi.clearAllMocks()
    filters.filters.isNew = false
    await nextTick()
    expect(track).not.toHaveBeenCalled()
  })

  it('fires kind:"quick-noLicense" only when noLicense toggles ON', async () => {
    const filters = makeFilters()
    wireFilterEvents({ filters, surface: '/browse/' })
    await nextTick()
    filters.filters.noLicense = true
    await nextTick()
    expect(track).toHaveBeenCalledWith('filter_change', { kind: 'quick-noLicense' })
  })

  it('fires kind:"sort" when sort changes (after first call)', async () => {
    const filters = makeFilters({ withSort: true })
    wireFilterEvents({ filters, surface: '/browse/' })
    await nextTick()
    filters.sort!.value = 'oldest'
    await nextTick()
    expect(track).toHaveBeenCalledWith('filter_change', { kind: 'sort', value: 'oldest' })
  })
})
