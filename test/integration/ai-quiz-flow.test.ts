import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRulesVrEnriched, collectAiGradedSpecs } from '../../scripts/parsers/rules.js'
import { expandAiAuthoredQuestions, populateAiAuthoredSiblingMaps } from '../../scripts/lib/expand-ai-authored.js'
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

const MOCK_RESP_TEXT = {
  toolCalls: [{
    name: 'submitQuiz',
    arguments: JSON.stringify({
      questions: [{
        type: 'text',
        question: 'Q?', correctAnswer: 'reference answer for the step',
      }],
    }),
  }],
  modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
}

describe('AI quiz flow — end to end (#208)', () => {
  it('synthetic rules.vr → expanded frontmatter → re-run hits cache', async () => {
    const rulesContent = `[AUTOAUTHOR_ALL:mcq]
`
    // [#311] Each step body must exceed MIN_SUBSTANTIVE_WORDS (50) substantive
    // words or the AI-author guard will skip the step and no LLM call will fire.
    // Padding with plausible-looking CAP tutorial prose keeps the guard happy
    // without dragging in real fixtures.
    const padding = 'In this step you will define a CAP service entity for the bookshop sample, deploy the schema to SAP HANA Cloud, and bind the destination service to the approuter so that the generated OData endpoints become reachable from the Fiori Elements preview, then run the unit tests locally to verify that the service handlers respond with the expected payload shape and authentication headers before pushing to Cloud Foundry.'
    const stepBodies = new Map<number, string>([
      [1, `body of step 1. ${padding}`],
      [2, `body of step 2. ${padding}`],
      [3, `body of step 3. ${padding}`],
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

  it('AI-authored text questions flow into aiGradedSpecs (#208 anti-leak chain)', async () => {
    const rulesContent = `[AUTOAUTHOR_ALL:text]\n`
    // [#311] Pad each step body past the 50 substantive-word guard.
    const padding = 'In this step you will define a CAP service entity for the bookshop sample, deploy the schema to SAP HANA Cloud, and bind the destination service to the approuter so that the generated OData endpoints become reachable from the Fiori Elements preview, then run the unit tests locally to verify that the service handlers respond with the expected payload shape and authentication headers before pushing to Cloud Foundry.'
    const stepBodies = new Map<number, string>([
      [1, `body of step 1. ${padding}`],
      [2, `body of step 2. ${padding}`],
      [3, `body of step 3. ${padding}`],
    ])

    const callModel = vi.fn().mockResolvedValue(MOCK_RESP_TEXT)
    const cache = loadAiQuizCache('synthetic-text-slug', { cacheDir: testCacheDir })
    const { map: validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId, allDirective } = parseRulesVrEnriched(rulesContent)
    const stats = { calls: 0, hits: 0, errors: 0 }
    await expandAiAuthoredQuestions(validationMap, stepBodies, {
      cache, callModel, onCallStats: stats, allDirective,
    })

    // Production-equivalent wiring: populate the sibling maps for AI-authored
    // text questions so collectAiGradedSpecs emits them. Without this, the
    // questions are silently dropped from the validate-answer-spec sidecar
    // and /api/validate-answer returns spec_missing at runtime.
    populateAiAuthoredSiblingMaps(validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId)

    const specs = collectAiGradedSpecs(validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId)
    expect(specs).toHaveLength(3)
    for (const spec of specs) {
      expect(spec.aiGrading).toBe(true)
      expect(spec.ruleType).toBe('ai-authored')
      expect(spec.correctAnswer).toBe('reference answer for the step')
      expect(spec.questionText).toBe('Q?')
    }
  })
})
