// scripts/__tests__/ai-quiz-invariants.test.ts
import { describe, it, expect } from 'vitest'
import {
  invariantNoUpstreamErrors,
  invariantPrecedence,
  invariantAntiLeak,
  invariantMcqShape,
  invariantGeneratorSanity,
  runAllInvariants,
  CURRENT_PROMPT_VERSION,
} from '../lib/ai-quiz-invariants'
import type { AiQuizCache } from '../lib/ai-quiz-cache'
import type { ValidationQuestion } from '../parsers/types'

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

  // [#311] Empty-step guard added a new "<n> empty-step skipped" token to
  // the summary line. The regex was updated to accept it as optional —
  // these two tests assert both shapes still parse.
  it('passes the post-#311 summary line shape (with empty-step skipped token)', () => {
    const line = '[ai-author] expanded directives across all tutorials: 6 cache miss (LLM call), 0 cache hit, 0 errors, 3 empty-step skipped. Build cap: 200.'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(true)
    expect(result.details?.miss).toBe(6)
    expect(result.details?.hit).toBe(0)
    expect(result.details?.errors).toBe(0)
  })

  it('passes the pre-#311 summary line shape (no empty-step skipped token) — backwards compat', () => {
    const line = '[ai-author] expanded directives across all tutorials: 6 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(true)
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

// ---------------------------------------------------------------------------
// Invariant 3: anti-leak
// ---------------------------------------------------------------------------

const aiTextQuestion = (overrides: Partial<ValidationQuestion> = {}): ValidationQuestion => ({
  id: 'validate-3-ai-1',
  question: 'Why does X work?',
  type: 'text',
  aiAuthored: true,
  aiGrading: true,
  __aiCorrectAnswer: 'Because of Y.',
  ...overrides,
})

const wrapInCache = (qs: ValidationQuestion[]): AiQuizCache => ({
  promptVersion: 'v1',
  modelName: 'fake',
  entries: {
    '3': { stepHash: 'h', directive: '[AUTOAUTHOR_3]', types: 'text-only', generatedAt: 'now', questions: qs },
  },
})

describe('invariantAntiLeak', () => {
  it('passes for a clean text question', () => {
    expect(invariantAntiLeak(wrapInCache([aiTextQuestion()])).passed).toBe(true)
  })

  it('passes when no text questions exist', () => {
    expect(invariantAntiLeak(wrapInCache([])).passed).toBe(true)
  })

  it('fails when text question has correctAnswer set (leak)', () => {
    const leaky = aiTextQuestion({ correctAnswer: 'Because of Y.' })
    const result = invariantAntiLeak(wrapInCache([leaky]))
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/leak|correctAnswer/i)
  })

  it('fails when text question is missing __aiCorrectAnswer', () => {
    const stripped = { ...aiTextQuestion(), __aiCorrectAnswer: undefined }
    const result = invariantAntiLeak(wrapInCache([stripped]))
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/__aiCorrectAnswer/)
  })

  it('skips MCQ questions (they DO have correctAnswer)', () => {
    const mcq: ValidationQuestion = {
      id: 'validate-3-ai-1',
      question: 'Pick one',
      type: 'multiple-choice',
      options: ['a', 'b'],
      correctAnswer: 'a',
      aiAuthored: true,
    }
    expect(invariantAntiLeak(wrapInCache([mcq])).passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Invariant 4: mcq-shape
// ---------------------------------------------------------------------------

const mcq = (overrides: Partial<ValidationQuestion> = {}): ValidationQuestion => ({
  id: 'validate-3-ai-1',
  question: 'Pick',
  type: 'multiple-choice',
  options: ['alpha', 'beta', 'gamma'],
  correctAnswer: 'alpha',
  aiAuthored: true,
  ...overrides,
})

describe('invariantMcqShape', () => {
  it('passes for 3-option MCQ with valid answer', () => {
    expect(invariantMcqShape(wrapInCache([mcq()])).passed).toBe(true)
  })

  it('passes for 2 and 4 option MCQ', () => {
    expect(invariantMcqShape(wrapInCache([mcq({ options: ['a', 'b'], correctAnswer: 'a' })])).passed).toBe(true)
    expect(invariantMcqShape(wrapInCache([mcq({ options: ['a', 'b', 'c', 'd'], correctAnswer: 'd' })])).passed).toBe(true)
  })

  it('fails for 1 option', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ options: ['only'], correctAnswer: 'only' })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/1 option/)
  })

  it('fails for 5 options', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ options: ['a', 'b', 'c', 'd', 'e'] })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/5 option/)
  })

  it('fails when options missing entirely', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ options: undefined })]))
    expect(r.passed).toBe(false)
  })

  it('fails when correctAnswer missing', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ correctAnswer: undefined })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/correctAnswer/)
  })

  it('fails when correctAnswer is not in options (verbatim)', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ correctAnswer: 'Alpha' /* capital A */ })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/not in options/i)
  })

  it('skips text questions', () => {
    const text: ValidationQuestion = { id: 't', question: 'Why', type: 'text', aiAuthored: true, __aiCorrectAnswer: 'because' }
    expect(invariantMcqShape(wrapInCache([text])).passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Invariant 5: generator-sanity
// ---------------------------------------------------------------------------

describe('invariantGeneratorSanity', () => {
  const goodCache = (): AiQuizCache => ({
    promptVersion: 'v1',
    modelName: 'anthropic--claude-4.6-sonnet',
    entries: {
      '3': {
        stepHash: 'h',
        directive: '[AUTOAUTHOR_3]',
        types: 'mcq-only',
        generatedAt: 'now',
        questions: [{ id: 'q', question: 'Pick', type: 'multiple-choice', options: ['a', 'b'], correctAnswer: 'a' }],
      },
    },
  })

  it('passes a fully-formed cache', () => {
    expect(invariantGeneratorSanity(goodCache(), 'v1').passed).toBe(true)
  })

  it('passes an empty entries map (no AI ran on this tutorial)', () => {
    const c: AiQuizCache = { promptVersion: 'v1', modelName: 'm', entries: {} }
    expect(invariantGeneratorSanity(c, 'v1').passed).toBe(true)
  })

  it('fails when promptVersion mismatches expected', () => {
    const c = goodCache()
    c.promptVersion = 'v0'
    const r = invariantGeneratorSanity(c, 'v1')
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/promptVersion/)
  })

  it('fails when modelName is empty (entries non-empty)', () => {
    const c = goodCache()
    c.modelName = ''
    expect(invariantGeneratorSanity(c, 'v1').passed).toBe(false)
  })

  it('fails when an entry has zero questions', () => {
    const c = goodCache()
    c.entries['3'].questions = []
    const r = invariantGeneratorSanity(c, 'v1')
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/0 questions/)
  })
})

// ---------------------------------------------------------------------------
// runAllInvariants aggregator
// ---------------------------------------------------------------------------

describe('runAllInvariants', () => {
  it('returns 5 results in stable name order', () => {
    const results = runAllInvariants({
      slug: 'fake',
      cache: { promptVersion: 'v1', modelName: 'm', entries: {} },
      handAuthoredSteps: new Set(),
      summaryLine: '[ai-author] expanded directives across all tutorials: 0 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.',
    })
    expect(results.map(r => r.name)).toEqual([
      'no-upstream-errors',
      'precedence',
      'anti-leak',
      'mcq-shape',
      'generator-sanity',
    ])
    expect(results.every(r => r.passed)).toBe(true)
  })

  it('uses CURRENT_PROMPT_VERSION when expectedPromptVersion omitted', () => {
    expect(CURRENT_PROMPT_VERSION).toBe('v1')
  })
})
