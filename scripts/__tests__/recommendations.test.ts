import { describe, it, expect } from 'vitest'
import { computeRecommendations } from '../parsers/recommendations'
import type { TutorialNavEntry } from '../parsers/types'

function navEntry(overrides: Partial<TutorialNavEntry>): TutorialNavEntry {
  return {
    slug: 'a',
    title: 'A',
    description: '',
    time: 5,
    level: 'beginner',
    stepCount: 1,
    primaryTag: '',
    displayTags: [],
    prev: null,
    next: null,
    ...overrides,
  }
}

describe('computeRecommendations', () => {
  it('returns empty array when no other tutorial shares any tag', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'alpha', primaryTag: 'a', displayTags: ['x'] }),
      navEntry({ slug: 'beta',  primaryTag: 'b', displayTags: ['y'] }),
    ]
    const result = computeRecommendations(entries)
    expect(result.get('alpha')).toEqual([])
    expect(result.get('beta')).toEqual([])
  })

  it('ranks primaryTag matches above tag-only matches', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',  primaryTag: 'cap',  displayTags: ['CAP', 'Node'] }),
      navEntry({ slug: 'tag-only', primaryTag: 'btp', displayTags: ['CAP', 'Node', 'BTP'] }),
      navEntry({ slug: 'primary-match', primaryTag: 'cap', displayTags: ['CAP'] }),
    ]
    const result = computeRecommendations(entries)
    // primary-match has primaryTag bonus (+10) + 1 tag overlap → 11
    // tag-only has 2 tag overlaps → 2
    expect(result.get('target')).toEqual(['primary-match', 'tag-only'])
  })

  it('excludes tutorials in the same mission as the target', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',     missionId: 1, primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'sibling',    missionId: 1, primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'outsider',   missionId: 2, primaryTag: 'cap', displayTags: ['CAP'] }),
    ]
    const result = computeRecommendations(entries)
    expect(result.get('target')).toEqual(['outsider'])
  })

  it('truncates to top 3 by default and breaks ties by title alphabetically', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target', primaryTag: 'x', displayTags: ['X'] }),
      navEntry({ slug: 'aa',     title: 'AA', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
      navEntry({ slug: 'bb',     title: 'BB', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
      navEntry({ slug: 'cc',     title: 'CC', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
      navEntry({ slug: 'dd',     title: 'DD', primaryTag: 'x', displayTags: ['X'] }), // primary match → 11
    ]
    const result = computeRecommendations(entries)
    expect(result.get('target')).toEqual(['aa', 'bb', 'cc'])
  })

  it('blends co-completion (60%) with tag-overlap (40%) when co-completion data exists', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',         primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'tag-strong',     primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'co-strong',      primaryTag: 'btp', displayTags: ['BTP'] }),
    ]
    const coCompletions = new Map([
      ['target', new Map([['co-strong', 100]])],
    ])
    const result = computeRecommendations(entries, { coCompletions })
    expect(result.get('target')?.[0]).toBe('co-strong')
  })

  it('falls back to pure tag scoring for slugs missing from co-completion map', () => {
    const entries: TutorialNavEntry[] = [
      navEntry({ slug: 'target',  primaryTag: 'cap', displayTags: ['CAP'] }),
      navEntry({ slug: 'related', primaryTag: 'cap', displayTags: ['CAP'] }),
    ]
    const coCompletions = new Map() // empty
    const result = computeRecommendations(entries, { coCompletions })
    expect(result.get('target')).toEqual(['related'])
  })
})
