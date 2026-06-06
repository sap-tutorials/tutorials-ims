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

    await expandAiAuthoredQuestions(parsedMap, stepBodies, { cache, callModel, onCallStats: stats })

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
      cache, callModel, onCallStats: stats, hardCap: 2,
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

    await expandAiAuthoredQuestions(parsedMap, stepBodies, { cache, callModel, onCallStats: stats })

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
      cache, callModel, onCallStats: { calls: 0, hits: 0, errors: 0 },
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
      cache, callModel, onCallStats: { calls: 0, hits: 0, errors: 0 },
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
      cache, callModel, onCallStats: stats, allDirective,
    })

    expect(callModel).toHaveBeenCalledTimes(3)
    expect(stats.calls).toBe(3)
    for (const stepNum of [1, 2, 3]) {
      expect(parsedMap.get(stepNum)?.[0]).toMatchObject({ aiAuthored: true })
    }
  })
})
