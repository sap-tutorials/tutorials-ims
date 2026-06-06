// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ref, nextTick } from 'vue'
import { useNavigatorFilters } from './useNavigatorFilters'
import type { CardItem } from '@shared/types'

const cards: CardItem[] = [
  { type: 'mission', id: 'm1', title: 'M1', description: '', time: 60, level: 'beginner', tutorialCount: 3, primaryTag: '', displayTags: [], displayTagSlugs: ['software-product>sap-build-apps'], href: '/x', stepCount: 6 },
  { type: 'tutorial', id: 't1', title: 'T1 cap', description: '', time: 30, level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: ['CAP'], displayTagSlugs: ['software-product>sap-cloud-application-programming-model'], href: '/x', stepCount: 3 },
  { type: 'tutorial', id: 't2', title: 'T2', description: '', time: 30, level: 'advanced', tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: ['software-product>sap-build-apps'], href: '/x', stepCount: 2 },
]

describe('useNavigatorFilters', () => {
  it('returns all cards when no filters active', () => {
    const allCards = ref(cards)
    const { displayedItems } = useNavigatorFilters({ allCards, syncURL: false })
    expect(displayedItems.value.length).toBe(3)
  })

  it('filters by type', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.types = ['mission']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1'])
  })

  it('filters by level (case-insensitive on read)', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.levels = ['advanced']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t2'])
  })

  it('filters by product slug', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.products = ['software-product>sap-cloud-application-programming-model']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })

  it('search "cap" matches title containing cap', async () => {
    // With no `tutorials` ref provided, server search isn't usable so the
    // composable falls back to client-side filteredItems for query matching.
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.searchQuery.value = 'cap'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1'])
  })

  it('clearFilters resets every dimension and currentPage to 1', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.types = ['mission']
    f.searchQuery.value = 'foo'
    f.currentPage.value = 3
    f.clearFilters()
    await nextTick()
    expect(f.filters.types).toEqual([])
    expect(f.searchQuery.value).toBe('')
    expect(f.currentPage.value).toBe(1)
    expect(f.displayedItems.value.length).toBe(3)
  })

  it('hasActiveFilters reflects any non-default state', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    expect(f.hasActiveFilters.value).toBe(false)
    f.filters.types = ['mission']
    expect(f.hasActiveFilters.value).toBe(true)
    f.clearFilters()
    expect(f.hasActiveFilters.value).toBe(false)
  })

  it('sort=recent orders by createdAt desc when enableSort=true and items have createdAt', async () => {
    const dated: CardItem[] = [
      { ...cards[0], id: 'old', createdAt: '2024-01-01T00:00:00Z' },
      { ...cards[1], id: 'new', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const allCards = ref(dated)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'recent'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['new', 'old'])
  })

  it('sort=updated orders by updatedAt desc', async () => {
    const dated: CardItem[] = [
      { ...cards[0], id: 'old', updatedAt: '2024-06-01T00:00:00Z' },
      { ...cards[1], id: 'new', updatedAt: '2026-06-01T00:00:00Z' },
      { ...cards[2], id: 'mid', updatedAt: '2025-06-01T00:00:00Z' },
    ]
    const allCards = ref(dated)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'updated'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sort=title orders alphabetically', async () => {
    const titled: CardItem[] = [
      { ...cards[0], id: 'c', title: 'Charlie' },
      { ...cards[1], id: 'a', title: 'Alpha' },
      { ...cards[2], id: 'b', title: 'Bravo' },
    ]
    const allCards = ref(titled)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'title'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('sort=time orders by time-to-complete ascending (short first)', async () => {
    const timed: CardItem[] = [
      { ...cards[0], id: 'long', time: 240 },
      { ...cards[1], id: 'short', time: 30 },
      { ...cards[2], id: 'medium', time: 90 },
    ]
    const allCards = ref(timed)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.sort!.value = 'time'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['short', 'medium', 'long'])
  })

  it('sort=relevance is a no-op (preserves filteredItems order)', async () => {
    // Default 'relevance' uses comparator () => 0, so the input order
    // (filteredItems pipeline output) survives untouched. Important: changing
    // this contract would silently break any consumer that relies on
    // cap-search's relevance ordering being preserved.
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    // sort defaults to 'relevance'; without setting it, the items should
    // be in the same order as `cards`.
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1', 't1', 't2'])
    // Explicit relevance after a change should also be identity.
    f.sort!.value = 'title'
    await nextTick()
    f.sort!.value = 'relevance'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['m1', 't1', 't2'])
  })

  it('sort works alongside filters (sort applied to filtered subset)', async () => {
    const both: CardItem[] = [
      { ...cards[0], id: 'm1', title: 'Mission Bravo' },
      { ...cards[1], id: 't1', title: 'Tutorial Alpha' },
      { ...cards[2], id: 't2', title: 'Tutorial Charlie' },
    ]
    const allCards = ref(both)
    const f = useNavigatorFilters({ allCards, syncURL: false, enableSort: true })
    f.filters.types = ['tutorial']    // narrow to t1, t2
    f.sort!.value = 'title'
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id)).toEqual(['t1', 't2'])  // Alpha, Charlie
  })

  it('sort is undefined when enableSort=false (default)', () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    expect(f.sort).toBeUndefined()
  })
})
