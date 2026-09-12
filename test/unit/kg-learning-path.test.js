// test/unit/kg-learning-path.test.js
import { describe, it, expect } from 'vitest'
import { computeLearningPath } from '../../srv/lib/kg/learning-path.js'

// Helper: build a graph snapshot. requires edge {source,target} means "source requires target"
// i.e. target is a prerequisite of source.
function graph({ requires = [], teaches = {}, goalConcepts = [], rank = {}, completed = [] }) {
  return {
    requires,
    teaches: new Map(Object.entries(teaches)),
    goalConcepts,
    tutorialRank: new Map(Object.entries(rank)),
    completedTutorials: new Set(completed),
  }
}

describe('computeLearningPath — linear chain', () => {
  it('orders prerequisites before the goal (c requires b requires a)', () => {
    const g = graph({
      requires: [
        { source: 'c', target: 'b', confidence: 0.9 },
        { source: 'b', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'], c: ['t-c'] },
      goalConcepts: ['c'],
      rank: { 't-a': 1, 't-b': 1, 't-c': 1 },
    })
    const { steps, meta } = computeLearningPath({
      goalType: 'tutorial', goal: 't-c', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-a', 't-b', 't-c'])
    expect(steps.map(s => s.order)).toEqual([1, 2, 3])
    expect(meta.truncated).toBe(false)
    expect(meta.cyclesBroken).toBe(0)
  })
})

describe('computeLearningPath — learned subtraction', () => {
  it('drops concepts the learner already knows and their tutorials', () => {
    const g = graph({
      requires: [
        { source: 'c', target: 'b', confidence: 0.9 },
        { source: 'b', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'], c: ['t-c'] },
      goalConcepts: ['c'],
      rank: { 't-a': 1, 't-b': 1, 't-c': 1 },
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-c', learnedConcepts: ['a'], partialConcepts: [], graph: g,
    })
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-b', 't-c'])
  })

  it('keeps a partial concept but flags alreadyPartial', () => {
    const g = graph({
      requires: [{ source: 'b', target: 'a', confidence: 0.9 }],
      teaches: { a: ['t-a'], b: ['t-b'] },
      goalConcepts: ['b'],
      rank: { 't-a': 1, 't-b': 1 },
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-b', learnedConcepts: [], partialConcepts: ['a'], graph: g,
    })
    const stepA = steps.find(s => s.tutorialSlug === 't-a')
    expect(stepA.alreadyPartial).toBe(true)
  })
})

describe('computeLearningPath — diamond dedup', () => {
  it('places a tutorial covering two concepts once, at its earliest valid position', () => {
    // d requires b and c; b requires a; c requires a. tutorial t-a teaches a.
    const g = graph({
      requires: [
        { source: 'd', target: 'b', confidence: 0.9 },
        { source: 'd', target: 'c', confidence: 0.9 },
        { source: 'b', target: 'a', confidence: 0.9 },
        { source: 'c', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-bc'], c: ['t-bc'], d: ['t-d'] },
      goalConcepts: ['d'],
      rank: { 't-a': 1, 't-bc': 1, 't-d': 1 },
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-d', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    const slugs = steps.map(s => s.tutorialSlug)
    expect(slugs.filter(s => s === 't-bc').length).toBe(1) // deduped
    expect(slugs.indexOf('t-a')).toBeLessThan(slugs.indexOf('t-bc'))
    expect(slugs.indexOf('t-bc')).toBeLessThan(slugs.indexOf('t-d'))
  })
})

describe('computeLearningPath — cycle breaking', () => {
  it('breaks the lowest-confidence edge and still returns a valid ordering', () => {
    // a requires b (0.4), b requires a (0.9) -> cycle; drop a->b (lower conf).
    const g = graph({
      requires: [
        { source: 'a', target: 'b', confidence: 0.4 },
        { source: 'b', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'] },
      goalConcepts: ['a'],
      rank: { 't-a': 1, 't-b': 1 },
    })
    const { steps, meta } = computeLearningPath({
      goalType: 'tutorial', goal: 't-a', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    expect(meta.cyclesBroken).toBeGreaterThanOrEqual(1)
    // With a->b dropped, b requires a survives => a before b.
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-a', 't-b'])
  })
})

describe('computeLearningPath — best-tutorial selection', () => {
  it('picks the highest-rank tutorial teaching a concept, preferring incomplete', () => {
    const g = graph({
      requires: [],
      teaches: { a: ['t-lo', 't-hi', 't-done'] },
      goalConcepts: ['a'],
      rank: { 't-lo': 0.1, 't-hi': 0.9, 't-done': 0.99 },
      completed: ['t-done'],
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-x', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    // t-done is highest rank but completed => excluded; t-hi wins over t-lo.
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-hi'])
  })
})

describe('computeLearningPath — next-best (no goal)', () => {
  it('returns unlearned concepts whose prereqs are all satisfied, ranked, capped', () => {
    // b requires a; c requires a. learner knows a. frontier = {b, c}.
    const g = graph({
      requires: [
        { source: 'b', target: 'a', confidence: 0.9 },
        { source: 'c', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'], c: ['t-c'] },
      goalConcepts: [],
      rank: { 't-b': 0.9, 't-c': 0.5 },
    })
    const { steps } = computeLearningPath({
      goalType: 'next-best', goal: '', learnedConcepts: ['a'], partialConcepts: [], graph: g, limit: 5,
    })
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-b', 't-c']) // ranked desc
  })
})

describe('computeLearningPath — truncation bound', () => {
  it('flags truncated when the closure exceeds maxNodes', () => {
    // Build a chain longer than the node cap.
    const N = 250
    const requires = []
    const teaches = {}
    for (let i = 0; i < N; i++) {
      teaches['k' + i] = ['t' + i]
      if (i > 0) requires.push({ source: 'k' + i, target: 'k' + (i - 1), confidence: 0.9 })
    }
    const g = graph({ requires, teaches, goalConcepts: ['k' + (N - 1)] })
    const { meta } = computeLearningPath({
      goalType: 'tutorial', goal: 't' + (N - 1), learnedConcepts: [], partialConcepts: [], graph: g,
    })
    expect(meta.truncated).toBe(true)
  })
})
