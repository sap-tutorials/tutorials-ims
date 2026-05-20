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
})
