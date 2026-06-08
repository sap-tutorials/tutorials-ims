// scripts/__tests__/ai-quiz-invariants.test.ts
import { describe, it, expect } from 'vitest'
import { invariantNoUpstreamErrors } from '../lib/ai-quiz-invariants'

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
