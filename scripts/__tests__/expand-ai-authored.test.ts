import { describe, it, expect, vi, beforeEach } from 'vitest'
import { expandAiAuthoredQuestions } from '../lib/expand-ai-authored.js'
import type { ValidationQuestion } from '../parsers/types.js'
import type { AiQuizCache } from '../lib/ai-quiz-cache.js'

const PLACEHOLDER = (stepNum: number, types: 'mcq-and-text' | 'mcq-only' | 'text-only' = 'mcq-and-text') => ({
  id: `autoauthor-${stepNum}`,
  question: '__autoauthor_placeholder__',
  type: 'text' as const,
  __autoauthor: true,
  __directiveTypes: types,
})

const FAKE_QUESTION = (idx: number): ValidationQuestion => ({
  id: `validate-1-ai-${idx}`,
  question: `Q${idx}`,
  type: 'multiple-choice',
  options: ['a', 'b', 'c', 'd'],
  correctAnswer: 'a',
  aiAuthored: true,
})

let cache: AiQuizCache
beforeEach(() => {
  cache = { promptVersion: 'v1', modelName: 'gpt-test', entries: {} }
})

describe('expandAiAuthoredQuestions (#208)', () => {
  it('cache hit: no callModel invocation; questions swapped from cache', async () => {
    cache.entries['1'] = {
      stepHash: 'precomputed-hash-1',
      directive: '[AUTOAUTHOR_1]',
      types: 'mcq-and-text',
      generatedAt: '2026-06-05T00:00:00Z',
      questions: [FAKE_QUESTION(1)],
    }
    const callModel = vi.fn()  // never called
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'step body 1']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache,
      callModel,
      onCallStats: stats,
      // Provide a hashKey override so the test cache entry's stepHash matches.
      hashKeyOverride: () => 'precomputed-hash-1',
      minSubstantiveWords: 0,  // tests use short fixture bodies; #311 guard lives in its own suite
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ calls: 0, hits: 1 })
    expect(parsedMap.get(1)).toEqual([FAKE_QUESTION(1)])
  })

  it('cache miss: callModel called once; new entry written; questions swapped', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'fresh body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, { cache, callModel, onCallStats: stats, minSubstantiveWords: 0 })

    expect(callModel).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ calls: 1, hits: 0, errors: 0 })
    expect(cache.entries['1']).toBeDefined()
    expect(parsedMap.get(1)?.[0]).toMatchObject({ aiAuthored: true })
  })

  it('hard cap reached: subsequent placeholders dropped; warning logged; not failed', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([
      [1, [PLACEHOLDER(1)]],
      [2, [PLACEHOLDER(2)]],
      [3, [PLACEHOLDER(3)]],
    ])
    const stepBodies = new Map<number, string>([[1, 'b1'], [2, 'b2'], [3, 'b3']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats, hardCap: 2, minSubstantiveWords: 0,
    })

    expect(callModel).toHaveBeenCalledTimes(2)
    // Step 3 dropped — no questions emitted, placeholder removed.
    expect(parsedMap.get(3)).toEqual([])
  })

  it('generator errorReason → placeholder dropped; build continues', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'NOT-IN-OPTS' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, { cache, callModel, onCallStats: stats, minSubstantiveWords: 0 })

    expect(stats.errors).toBe(1)
    expect(parsedMap.get(1)).toEqual([])  // placeholder dropped
  })

  it('sentinel fields (__autoauthor, __directiveTypes) stripped from emitted questions', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: { calls: 0, hits: 0, errors: 0 }, minSubstantiveWords: 0,
    })

    const out = parsedMap.get(1)?.[0]
    expect(out).toBeDefined()
    expect((out as any).__autoauthor).toBeUndefined()
    expect((out as any).__directiveTypes).toBeUndefined()
  })

  it('text questions get correctAnswer RESTORED on parsedMap (for collectAiGradedSpecs); cache keeps __aiCorrectAnswer', async () => {
    // The generator strips correctAnswer + stashes it on __aiCorrectAnswer (anti-leak).
    // The existing collectAiGradedSpecs (#234) reads correctAnswer; without
    // restoration, AI-authored text reference answers would silently fail
    // to upload to ValidateAnswerSpecs.
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'text', question: 'Explain X', correctAnswer: 'X is the answer.' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1, 'text-only')]]])
    const stepBodies = new Map<number, string>([[1, 'body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: { calls: 0, hits: 0, errors: 0 }, minSubstantiveWords: 0,
    })

    // parsedMap (consumed by collectAiGradedSpecs): correctAnswer restored, __aiCorrectAnswer stripped.
    const onMap = parsedMap.get(1)?.[0] as any
    expect(onMap.correctAnswer).toBe('X is the answer.')
    expect(onMap.__aiCorrectAnswer).toBeUndefined()
    expect(onMap.aiGrading).toBe(true)

    // Cache (consumed by eval harness): __aiCorrectAnswer kept, correctAnswer absent.
    const inCache = cache.entries['1'].questions[0] as any
    expect(inCache.__aiCorrectAnswer).toBe('X is the answer.')
    expect(inCache.correctAnswer).toBeUndefined()
  })

  it('all-directive expands against the step list when no per-step placeholders are present', async () => {
    // Tutorial-wide [AUTOAUTHOR_ALL] applies to every step in stepBodies that
    // doesn't already have content in parsedMap.
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    // parsedMap is empty (no per-step directives, no hand-authored content)
    const parsedMap = new Map<number, any[]>()
    const stepBodies = new Map<number, string>([[1, 'b1'], [2, 'b2'], [3, 'b3']])
    const allDirective = { types: 'mcq-only' as const, present: true as const }

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats, allDirective, minSubstantiveWords: 0,
    })

    expect(callModel).toHaveBeenCalledTimes(3)
    expect(stats.calls).toBe(3)
    for (const stepNum of [1, 2, 3]) {
      expect(parsedMap.get(stepNum)?.[0]).toMatchObject({ aiAuthored: true })
    }
  })
})

describe('expandAiAuthoredQuestions handAuthoredSteps precedence (#208)', () => {
  it('skips a step listed in handAuthoredSteps even when parsedMap has no entry for it', async () => {
    const parsedMap = new Map<number, ValidationQuestion[]>()
    // step 1 has no entry in parsedMap (e.g. regex-substring case); step 2 also empty.
    const stepBodies = new Map([[1, 'body of step 1'], [2, 'body of step 2']])
    const handAuthoredSteps = new Set([1])  // step 1 IS hand-authored (e.g. regex-substring); step 2 is NOT.

    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const allDirective = { types: 'mcq-and-text' as const, present: true as const }

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
      allDirective,
      handAuthoredSteps,
      minSubstantiveWords: 0,
    })

    // Step 1 should NOT have an AI placeholder (skipped due to handAuthoredSteps)
    expect((parsedMap.get(1) ?? []).length).toBe(0)
    // Step 2 SHOULD have AI questions
    expect((parsedMap.get(2) ?? []).length).toBeGreaterThan(0)
    expect(callModel).toHaveBeenCalledTimes(1)
    expect(stats.calls).toBe(1)
  })
})

describe('expandAiAuthoredQuestions empty-step guard (#311)', () => {
  // Helper: build a body with N substantive words. Pads with the same
  // 5-word phrase so a tester can read it back.
  const bodyWithWords = (n: number): string => {
    const phrase = 'one two three four five'
    const reps = Math.ceil(n / 5)
    return Array.from({ length: reps }, () => phrase).join(' ')
  }

  it('skips empty step body — no LLM call, placeholder dropped, warning logged', async () => {
    const callModel = vi.fn()  // never called
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[5, [PLACEHOLDER(5)]]])
    const stepBodies = new Map<number, string>([[5, '']])  // empty step
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
      // No minSubstantiveWords override — uses default 50.
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ calls: 0, hits: 0, errors: 0, skips: 1 })
    expect(parsedMap.get(5)).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping empty step 5'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('0 substantive words'))
    warnSpy.mockRestore()
  })

  it('skips placeholder-only step (### Test yourself with no body) — abap-create-project step-5 repro', async () => {
    // Body that's just a directive marker — counts to 0 substantive words after stripping.
    const callModel = vi.fn()
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[5, [PLACEHOLDER(5)]]])
    const stepBodies = new Map<number, string>([[5, '[AUTOAUTHOR_5]']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(stats.skips).toBe(1)
    expect(parsedMap.get(5)).toEqual([])
  })

  it('skips link-only "see also" body — common Test Yourself shape', async () => {
    const linkBody = `
- [Tutorial: Foo](foo)
- [Tutorial: Bar](bar)
- [Tutorial: Baz](baz)
`.trim()
    const callModel = vi.fn()
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[3, [PLACEHOLDER(3)]]])
    const stepBodies = new Map<number, string>([[3, linkBody]])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(stats.skips).toBe(1)
    expect(parsedMap.get(3)).toEqual([])
  })

  it('skips code-fence-only body — code mass != tutorial intent', async () => {
    const codeOnly = '```js\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```'
    const callModel = vi.fn()
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, codeOnly]])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(stats.skips).toBe(1)
  })

  it('does NOT skip body with 50+ words of substantive prose', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, bodyWithWords(60)]])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
    })

    expect(callModel).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ calls: 1, errors: 0 })
    expect(stats.skips ?? 0).toBe(0)
  })

  it('clears stale cache entry on guard fail — empty body must not surface ghost cache', async () => {
    // Cache has questions from a previous run when the body was substantive.
    // Now the body is empty — the guard fires AND the stale cache entry is purged.
    cache.entries['5'] = {
      stepHash: 'old-hash',
      directive: '[AUTOAUTHOR_5]',
      types: 'mcq-and-text',
      generatedAt: '2026-06-05T00:00:00Z',
      questions: [FAKE_QUESTION(99)],
    }
    const callModel = vi.fn()
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[5, [PLACEHOLDER(5)]]])
    const stepBodies = new Map<number, string>([[5, '']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats,
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(parsedMap.get(5)).toEqual([])
    // Cache entry should be GONE — a future re-seed against substantive content
    // must not see the ghost.
    expect(cache.entries['5']).toBeUndefined()
  })
})

describe('countSubstantiveWords (#311 helper)', () => {
  it('returns 0 for empty / null', async () => {
    const { countSubstantiveWords } = await import('../lib/expand-ai-authored.js')
    expect(countSubstantiveWords('')).toBe(0)
    expect(countSubstantiveWords('   \n  \t\n ')).toBe(0)
  })

  it('counts plain prose words', async () => {
    const { countSubstantiveWords } = await import('../lib/expand-ai-authored.js')
    expect(countSubstantiveWords('one two three four five')).toBe(5)
  })

  it('strips fenced code blocks before counting', async () => {
    const { countSubstantiveWords } = await import('../lib/expand-ai-authored.js')
    const body = 'one two three\n```js\nconst x = 1; const y = 2;\n```\nfour five'
    expect(countSubstantiveWords(body)).toBe(5)  // 3 + 2 prose; code stripped
  })

  it('strips author directives ([VALIDATE_N], [AUTOAUTHOR_N], [CODECHECK_N])', async () => {
    const { countSubstantiveWords } = await import('../lib/expand-ai-authored.js')
    expect(countSubstantiveWords('intro [VALIDATE_5] [AUTOAUTHOR_3] [CODECHECK_1] outro'))
      .toBe(2)  // 'intro' + 'outro'
  })

  it('strips bullet-of-link lines', async () => {
    const { countSubstantiveWords } = await import('../lib/expand-ai-authored.js')
    const body = `Some real prose here.\n- [Tutorial: Foo](foo)\n- [Tutorial: Bar](bar)\nMore real prose.`
    expect(countSubstantiveWords(body)).toBe(7)  // 'Some real prose here.' + 'More real prose.'
  })

  it('keeps inline links (not whole-line links) in the count', async () => {
    const { countSubstantiveWords } = await import('../lib/expand-ai-authored.js')
    // Inline link: text on the same line is part of substantive prose.
    expect(countSubstantiveWords('See the [docs](url) for more details.')).toBe(6)
  })
})
