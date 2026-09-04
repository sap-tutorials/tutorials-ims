import { describe, it, expect } from 'vitest'
import { aggregateDistribution, SURVEY_DIMENSIONS, type DistributionRow } from '../survey'

describe('aggregateDistribution', () => {
  it('sums response counts per (dimension, score) across slugs and computes pct within a dimension', () => {
    const rows: DistributionRow[] = [
      { tutorialSlug: 'a', dimension: 'structure', score: 8, responseCount: 2 },
      { tutorialSlug: 'b', dimension: 'structure', score: 8, responseCount: 1 },
      { tutorialSlug: 'a', dimension: 'structure', score: 6, responseCount: 1 },
      { tutorialSlug: 'a', dimension: 'nps', score: 10, responseCount: 4 },
    ]
    const agg = aggregateDistribution(rows)
    const structure = agg['structure']
    // score 8 => 2+1 = 3, score 6 => 1 ; total 4
    const s8 = structure.find(b => b.score === 8)!
    const s6 = structure.find(b => b.score === 6)!
    expect(s8.count).toBe(3)
    expect(s6.count).toBe(1)
    expect(s8.pct).toBeCloseTo(75, 5)
    expect(s6.pct).toBeCloseTo(25, 5)
    // nps independent dimension
    expect(agg['nps'][0].count).toBe(4)
    expect(agg['nps'][0].pct).toBeCloseTo(100, 5)
  })

  it('exposes the 7 survey dimensions in display order', () => {
    expect(SURVEY_DIMENSIONS).toEqual([
      'structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps'
    ])
  })

  it('returns an empty object for no rows', () => {
    expect(aggregateDistribution([])).toEqual({})
  })
})
