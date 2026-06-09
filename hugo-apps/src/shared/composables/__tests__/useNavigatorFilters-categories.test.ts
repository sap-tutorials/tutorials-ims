// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { ref, nextTick } from 'vue'
import { useNavigatorFilters } from '../useNavigatorFilters'
import type { CardItem } from '@shared/types'

const cards: CardItem[] = [
  { type: 'mission', id: 'm1', title: 'AI Mission', description: '', time: 30, level: 'beginner', tutorialCount: 2, primaryTag: '', displayTags: [], displayTagSlugs: [], href: '/x', stepCount: 4, categorySlugs: ['artificial-intelligence'] },
  { type: 'mission', id: 'm2', title: 'CAP Mission', description: '', time: 60, level: 'beginner', tutorialCount: 5, primaryTag: '', displayTags: [], displayTagSlugs: [], href: '/y', stepCount: 8, categorySlugs: ['app-dev-automation'] },
  { type: 'tutorial', id: 't1', title: 'AI+CAP', description: '', time: 15, level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [], href: '/z', stepCount: 3, categorySlugs: ['artificial-intelligence', 'app-dev-automation'] },
  { type: 'tutorial', id: 't2', title: 'No Cat', description: '', time: 5, level: 'beginner', tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [], href: '/q', stepCount: 1 /* no categorySlugs */ },
]

describe('useNavigatorFilters — categories', () => {
  it('passes everything through when no categories selected', () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    expect(f.displayedItems.value.length).toBe(4)
  })

  it('filters to a single selected category', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.categories = ['artificial-intelligence']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id).sort()).toEqual(['m1', 't1'])
  })

  it('OR-combines multiple selected categories', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.categories = ['artificial-intelligence', 'app-dev-automation']
    await nextTick()
    expect(f.displayedItems.value.map(c => c.id).sort()).toEqual(['m1', 'm2', 't1'])
  })

  it('items without categorySlugs are excluded once any category filter is set', async () => {
    const allCards = ref(cards)
    const f = useNavigatorFilters({ allCards, syncURL: false })
    f.filters.categories = ['app-dev-automation']
    await nextTick()
    // t2 has no categorySlugs; must be filtered out
    expect(f.displayedItems.value.map(c => c.id).sort()).toEqual(['m2', 't1'])
  })
})
