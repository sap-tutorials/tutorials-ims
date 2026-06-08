// scripts/__tests__/preflight-ai-quiz-smoke.test.ts
import { describe, it, expect } from 'vitest'
import {
  sampleSlugs,
  extractSummaryLine,
  summarizeVerdict,
} from '../preflight-ai-quiz-smoke'
import type { InvariantResult } from '../lib/ai-quiz-invariants'

const CATALOG = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

describe('sampleSlugs', () => {
  it('returns exactly n items', () => {
    expect(sampleSlugs(CATALOG, 3, 42).length).toBe(3)
  })

  it('returns unique items', () => {
    const r = sampleSlugs(CATALOG, 5, 42)
    expect(new Set(r).size).toBe(5)
  })

  it('is reproducible across calls with the same seed', () => {
    const a = sampleSlugs(CATALOG, 4, 1234)
    const b = sampleSlugs(CATALOG, 4, 1234)
    expect(a).toEqual(b)
  })

  it('produces different output for different seeds', () => {
    const a = sampleSlugs(CATALOG, 4, 1)
    const b = sampleSlugs(CATALOG, 4, 2)
    expect(a).not.toEqual(b)
  })

  it('returns the whole catalog when n >= catalog.length', () => {
    const r = sampleSlugs(CATALOG, 100, 42)
    expect(r.length).toBe(CATALOG.length)
    expect(new Set(r)).toEqual(new Set(CATALOG))
  })

  it('returns empty array for n=0', () => {
    expect(sampleSlugs(CATALOG, 0, 42)).toEqual([])
  })
})

describe('extractSummaryLine', () => {
  it('finds the line in interleaved stdout', () => {
    const stdout = [
      'fetched X',
      '[ai-author] expanded directives across all tutorials: 6 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.',
      'wrote hugo/content/...',
    ].join('\n')
    expect(extractSummaryLine(stdout)).toMatch(/^\[ai-author\]/)
  })

  it('returns null when missing', () => {
    expect(extractSummaryLine('boring output')).toBeNull()
  })

  it('returns the LAST occurrence when duplicated', () => {
    const stdout = [
      '[ai-author] expanded directives across all tutorials: 1 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.',
      '[ai-author] expanded directives across all tutorials: 5 cache miss (LLM call), 0 cache hit, 2 errors. Build cap: 200.',
    ].join('\n')
    expect(extractSummaryLine(stdout)).toMatch(/2 errors/)
  })
})

const okRow = (slug: string) => ({
  slug,
  durationMs: 1000,
  results: [
    { name: 'no-upstream-errors', passed: true },
    { name: 'precedence', passed: true },
    { name: 'anti-leak', passed: true },
    { name: 'mcq-shape', passed: true },
    { name: 'generator-sanity', passed: true },
  ] as InvariantResult[],
})

const failRow = (slug: string) => ({
  slug,
  durationMs: 1100,
  results: [
    { name: 'no-upstream-errors', passed: true },
    { name: 'precedence', passed: false, reason: 'step 3 leaked' },
    { name: 'anti-leak', passed: true },
    { name: 'mcq-shape', passed: true },
    { name: 'generator-sanity', passed: true },
  ] as InvariantResult[],
})

describe('summarizeVerdict', () => {
  it('safeToGraduate=true when all rows pass', () => {
    const verdict = summarizeVerdict([okRow('a'), okRow('b')])
    expect(verdict.safeToGraduate).toBe(true)
    expect(verdict.totals.passed).toBe(2)
    expect(verdict.totals.failed).toBe(0)
  })

  it('safeToGraduate=false on any fail', () => {
    const verdict = summarizeVerdict([okRow('a'), failRow('b')])
    expect(verdict.safeToGraduate).toBe(false)
    expect(verdict.totals.failed).toBe(1)
    expect(verdict.failedSlugs).toEqual(['b'])
  })

  it('counts failures by invariant name', () => {
    const verdict = summarizeVerdict([failRow('a'), failRow('b')])
    expect(verdict.failuresByInvariant.precedence).toBe(2)
  })

  it('treats fatalError as a failed row even with no invariant fails', () => {
    const verdict = summarizeVerdict([{
      slug: 'crash',
      durationMs: 50,
      results: [],
      fatalError: 'subprocess exited 137',
    }])
    expect(verdict.safeToGraduate).toBe(false)
    expect(verdict.failedSlugs).toEqual(['crash'])
  })
})
