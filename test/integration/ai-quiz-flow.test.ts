import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRulesVrEnriched } from '../../scripts/parsers/rules.js'
import { expandAiAuthoredQuestions } from '../../scripts/lib/expand-ai-authored.js'
import { loadAiQuizCache, saveAiQuizCache } from '../../scripts/lib/ai-quiz-cache.js'

let testCacheDir: string

beforeEach(() => {
  testCacheDir = join(tmpdir(), `ai-quiz-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(testCacheDir, { recursive: true })
})

afterEach(() => {
  rmSync(testCacheDir, { recursive: true, force: true })
})

const MOCK_RESP = {
  toolCalls: [{
    name: 'submitQuiz',
    arguments: JSON.stringify({
      questions: [{
        type: 'multiple-choice',
        question: 'Q?', options: ['a','b','c','d'], correctAnswer: 'a',
      }],
    }),
  }],
  modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
}

describe('AI quiz flow — end to end (#208)', () => {
  it('synthetic rules.vr → expanded frontmatter → re-run hits cache', async () => {
    const rulesContent = `[AUTOAUTHOR_ALL:mcq]
`
    const stepBodies = new Map<number, string>([
      [1, 'body of step 1'],
      [2, 'body of step 2'],
      [3, 'body of step 3'],
    ])

    // First pass: empty cache, 3 LLM calls expected.
    const callModel1 = vi.fn().mockResolvedValue(MOCK_RESP)
    const cache1 = loadAiQuizCache('synthetic-slug', { cacheDir: testCacheDir })
    const { map: parsedMap1, allDirective: ad1 } = parseRulesVrEnriched(rulesContent)
    const stats1 = { calls: 0, hits: 0, errors: 0 }
    await expandAiAuthoredQuestions(parsedMap1, stepBodies, {
      cache: cache1, callModel: callModel1, onCallStats: stats1, allDirective: ad1,
    })
    saveAiQuizCache('synthetic-slug', cache1, { cacheDir: testCacheDir })
    expect(callModel1).toHaveBeenCalledTimes(3)
    expect(stats1).toMatchObject({ calls: 3, hits: 0, errors: 0 })
    for (const stepNum of [1, 2, 3]) {
      expect(parsedMap1.get(stepNum)?.[0]).toMatchObject({ aiAuthored: true })
    }

    // Second pass: cache populated, 0 LLM calls, 3 cache hits.
    const callModel2 = vi.fn().mockResolvedValue(MOCK_RESP)
    const cache2 = loadAiQuizCache('synthetic-slug', { cacheDir: testCacheDir })
    const { map: parsedMap2, allDirective: ad2 } = parseRulesVrEnriched(rulesContent)
    const stats2 = { calls: 0, hits: 0, errors: 0 }
    await expandAiAuthoredQuestions(parsedMap2, stepBodies, {
      cache: cache2, callModel: callModel2, onCallStats: stats2, allDirective: ad2,
    })
    expect(callModel2).not.toHaveBeenCalled()
    expect(stats2).toMatchObject({ calls: 0, hits: 3, errors: 0 })
  })
})
