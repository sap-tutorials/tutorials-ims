// scripts/__tests__/ai-quiz-invariants.test.ts
import { describe, it, expect } from 'vitest'
import {
  invariantNoUpstreamErrors,
  invariantPrecedence,
} from '../lib/ai-quiz-invariants'
import type { AiQuizCache } from '../lib/ai-quiz-cache'

describe('invariantNoUpstreamErrors', () => {
  it('passes when summary line shows 0 errors', () => {
    const line = '[ai-author] expanded directives across all tutorials: 6 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(true)
    expect(result.name).toBe('no-upstream-errors')
    expect(result.reason).toBeUndefined()
    expect(result.details?.miss).toBe(6)
    expect(result.details?.hit).toBe(0)
    expect(result.details?.errors).toBe(0)
  })

  it('fails when summary line shows non-zero errors', () => {
    const line = '[ai-author] expanded directives across all tutorials: 4 cache miss (LLM call), 0 cache hit, 2 errors. Build cap: 200.'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/2 errors/)
    expect(result.details?.errors).toBe(2)
    expect(result.details?.miss).toBe(4)
    expect(result.details?.hit).toBe(0)
  })

  it('fails when summary line is missing entirely (subprocess crashed before emit)', () => {
    const result = invariantNoUpstreamErrors(null)
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/no \[ai-author\] summary line captured/i)
  })

  it('fails when summary line is malformed (regex miss)', () => {
    const line = '[ai-author] expanded directives — something garbled'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/could not parse/i)
  })
})

// ---------------------------------------------------------------------------
// Invariant 2: precedence
// ---------------------------------------------------------------------------

const emptyCache = (): AiQuizCache => ({ promptVersion: 'v1', modelName: 'fake', entries: {} })

const cacheWithStep = (n: number): AiQuizCache => ({
  promptVersion: 'v1',
  modelName: 'fake',
  entries: {
    [String(n)]: {
      stepHash: 'h',
      directive: '[AUTOAUTHOR_ALL]',
      types: 'mcq-and-text',
      generatedAt: '2026-06-08T00:00:00Z',
      questions: [],
    },
  },
})

describe('invariantPrecedence', () => {
  it('passes when no overlap', () => {
    const result = invariantPrecedence(cacheWithStep(2), new Set([1, 3]))
    expect(result.passed).toBe(true)
  })

  it('passes when both empty', () => {
    expect(invariantPrecedence(emptyCache(), new Set()).passed).toBe(true)
  })

  it('fails when AI fired on a hand-authored step (the PR #277 bug shape)', () => {
    const result = invariantPrecedence(cacheWithStep(3), new Set([3, 5]))
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/step 3/)
    expect(result.details?.violatingSteps).toEqual([3])
  })

  it('reports all violating steps when multiple', () => {
    const cache = cacheWithStep(2)
    cache.entries['4'] = { ...cache.entries['2'] }
    const result = invariantPrecedence(cache, new Set([2, 4]))
    expect(result.details?.violatingSteps).toEqual([2, 4])
  })
})
