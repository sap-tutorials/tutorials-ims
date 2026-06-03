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
})
