// scripts/lib/expand-ai-authored.ts
//
// Post-parse expansion: walks parser-emitted placeholders + the
// tutorial-wide [AUTOAUTHOR_ALL] directive, calls the LLM via the
// injected callModel (or hits cache), swaps real questions in.
//
// Pure module — no I/O beyond the cache and the injected callModel.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { generateQuiz } from '../../srv/lib/ai-quiz-generator.js'
import { hashKey, type AiQuizCache, type AiQuizCacheEntry } from './ai-quiz-cache.js'
import type { ValidationQuestion } from '../parsers/types.js'
import { QUESTION_TYPE_TEXT } from '../parsers/types.js'

export interface ExpandStats {
  calls: number    // cache miss → LLM call
  hits: number     // cache hit
  errors: number   // generator returned errorReason; placeholder dropped
}

export interface AllDirective {
  types: 'mcq-and-text' | 'mcq-only' | 'text-only'
  present: true
}

interface PlaceholderQuestion extends ValidationQuestion {
  __autoauthor?: true
  __directiveTypes?: 'mcq-and-text' | 'mcq-only' | 'text-only'
}

const DEFAULT_HARD_CAP = parseInt(process.env.AI_AUTHOR_BUILD_CAP ?? '200', 10)

/**
 * Walk the parsedMap for sentinel placeholders + apply the all-directive.
 * For each step that needs expansion, consult cache; on miss, call generator.
 *
 * Mutates parsedMap in place: placeholders are replaced with real questions,
 * or with `[]` if the cap is hit / generator errored.
 *
 * @param parsedMap   — Map<stepNumber, ValidationQuestion[]> from parseRulesVrEnriched()
 * @param stepBodies  — Map<stepNumber, string> markdown body per step
 * @param deps
 *   - cache         — loaded AiQuizCache (mutated; persist after this call)
 *   - callModel     — passes through to generateQuiz
 *   - onCallStats   — tracks calls/hits/errors across the build (caller persists)
 *   - hardCap       — defaults to AI_AUTHOR_BUILD_CAP env var or 200
 *   - allDirective  — optional tutorial-wide directive from parseRulesVrEnriched
 *   - hashKeyOverride — test-only: override hashKey() for deterministic cache lookups
 */
export async function expandAiAuthoredQuestions(
  parsedMap: Map<number, ValidationQuestion[]>,
  stepBodies: Map<number, string>,
  deps: {
    cache: AiQuizCache
    callModel: Parameters<typeof generateQuiz>[0]['deps']['callModel']
    onCallStats: ExpandStats
    hardCap?: number
    allDirective?: AllDirective
    // [#208 precedence-fix] Set of step numbers that have ANY hand-authored
    // [VALIDATE_N] block, including those whose parseBlock returned [] (e.g.
    // regex-substring without ###Question). Phase 3 must NOT fire AI on top
    // of these regardless of whether parsedMap has an entry.
    handAuthoredSteps?: Set<number>
    hashKeyOverride?: (input: any) => string
  },
): Promise<void> {
  const hardCap = deps.hardCap ?? DEFAULT_HARD_CAP
  const hk = deps.hashKeyOverride ?? hashKey

  // 1. Apply allDirective: materialize placeholders for steps that don't
  //    already have content in parsedMap. (Per-step directives have already
  //    been materialized by the parser.)
  if (deps.allDirective?.present) {
    for (const [stepNum] of stepBodies) {
      // [#208 precedence-fix] hand-authored wins over [AUTOAUTHOR_ALL],
      // even when parseBlock didn't emit a ValidationQuestion (e.g.
      // regex-substring blocks without ###Question).
      if (deps.handAuthoredSteps?.has(stepNum)) continue
      if ((parsedMap.get(stepNum) ?? []).length > 0) continue
      parsedMap.set(stepNum, [{
        id: `autoauthor-${stepNum}`,
        question: '__autoauthor_placeholder__',
        type: QUESTION_TYPE_TEXT,
        __autoauthor: true,
        __directiveTypes: deps.allDirective.types,
      } as PlaceholderQuestion])
    }
  }

  // 2. Walk all placeholders.
  for (const [stepNum, questions] of parsedMap) {
    const placeholder = questions.find(q => (q as PlaceholderQuestion).__autoauthor === true) as PlaceholderQuestion | undefined
    if (!placeholder) continue

    // Cap check: at-or-over the cap → drop placeholder, log warning.
    if (deps.onCallStats.calls >= hardCap) {
      console.warn(`[ai-author] hit hard cap ${hardCap}; skipping step ${stepNum}`)
      parsedMap.set(stepNum, [])
      continue
    }

    const stepBody = stepBodies.get(stepNum) ?? ''
    const directive = `[AUTOAUTHOR_${stepNum}${placeholder.__directiveTypes !== 'mcq-and-text' ? ':' + (placeholder.__directiveTypes === 'mcq-only' ? 'mcq' : 'text') : ''}]`
    const types = placeholder.__directiveTypes ?? 'mcq-and-text'

    const entryKey = String(stepNum)
    const computeHash = () =>
      hk({
        stepBody,
        directive,
        types,
        promptVersion: deps.cache.promptVersion,
        modelName: deps.cache.modelName,
      })
    const stepHash = computeHash()

    const cached = deps.cache.entries[entryKey]
    if (cached && cached.stepHash === stepHash) {
      deps.onCallStats.hits++
      // Cache stored the cache-snapshot shape (correctAnswer absent on
      // text); restore correctAnswer on the parsedMap pass-through so
      // collectAiGradedSpecs sees what it expects.
      parsedMap.set(stepNum, cached.questions.map(materializeForPipeline))
      continue
    }

    // Cache miss — call the generator.
    deps.onCallStats.calls++
    const result = await generateQuiz({
      stepBody,
      stepNumber: stepNum,
      slug: '<unknown>',  // expand-ai-authored doesn't know the slug; loaded by caller
      types,
      deps: { callModel: deps.callModel },
    })

    if (result.errorReason || result.questions.length === 0) {
      deps.onCallStats.errors++
      console.warn(`[ai-author] step ${stepNum}: ${result.errorReason ?? 'empty result'}`)
      parsedMap.set(stepNum, [])
      continue
    }

    // Two transforms — same questions, different shape per consumer:
    //
    //   forCache       — cache snapshot. Keeps __aiCorrectAnswer for the
    //                    eval harness (Task 8/9). correctAnswer absent on
    //                    text questions per the generator's anti-leak strip.
    //
    //   forParsedMap   — what fetch-tutorials.ts uses downstream. Restores
    //                    correctAnswer on text questions from
    //                    __aiCorrectAnswer so the existing collectAiGradedSpecs
    //                    (PR #234) sees what it expects. fetch-tutorials.ts
    //                    runs a final strip before emitting to public Hugo
    //                    frontmatter (the strip lives in fetch-tutorials.ts
    //                    Task 6 Step 5b, NOT here, because
    //                    collectAiGradedSpecs runs in fetch-tutorials between
    //                    expansion and frontmatter emission).
    const forCache = result.questions.map(stripParserSentinels)
    const forParsedMap = result.questions.map(materializeForPipeline)

    // Adopt the response's modelName before snapshotting the entry's
    // stepHash. Otherwise the first-pass hash uses cache.modelName='' and
    // the second-pass hash uses cache.modelName=<result.modelName>,
    // causing a guaranteed cache miss on the second pass for the very
    // first step expanded in the first pass.
    if (!deps.cache.modelName && result.modelName) {
      deps.cache.modelName = result.modelName
    }
    const finalStepHash = computeHash()

    const newEntry: AiQuizCacheEntry = {
      stepHash: finalStepHash,
      directive,
      types,
      generatedAt: new Date().toISOString(),
      questions: forCache,
    }
    deps.cache.entries[entryKey] = newEntry
    parsedMap.set(stepNum, forParsedMap)
  }
}

/**
 * For AI-authored text questions in the validation map, populate the
 * sibling maps that collectAiGradedSpecs uses to emit the
 * validate-answer-spec sidecar. Hand-authored questions are populated
 * by parseBlock; AI-authored questions arrive after parseRulesVrEnriched
 * returns and need this catch-up step.
 *
 * #208 final-review fix: without this, AI-authored text questions are
 * silently dropped from aiGradedSpecs and /api/validate-answer returns
 * spec_missing at runtime.
 */
export function populateAiAuthoredSiblingMaps(
  validationMap: Map<number, ValidationQuestion[]>,
  ruleTypeByStepAndId: Map<string, string>,
  correctAnswerByStepAndId: Map<string, string>,
): void {
  for (const [stepNumber, questions] of validationMap) {
    for (const q of questions) {
      if (q.aiAuthored && q.type === QUESTION_TYPE_TEXT) {
        const correctAnswer = q.correctAnswer
        if (typeof correctAnswer !== 'string' || correctAnswer.length === 0) continue
        const key = `${stepNumber}:${q.id}`
        correctAnswerByStepAndId.set(key, correctAnswer)
        ruleTypeByStepAndId.set(key, 'ai-authored')
      }
    }
  }
}

/**
 * Cache-snapshot transform. Strips parser sentinels (__autoauthor,
 * __directiveTypes) but KEEPS __aiCorrectAnswer for the eval harness.
 *
 * For text questions: correctAnswer is absent (generator stripped it),
 * __aiCorrectAnswer carries the reference answer.
 */
function stripParserSentinels(q: ValidationQuestion): ValidationQuestion {
  const clean: any = { ...q }
  delete clean.__autoauthor
  delete clean.__directiveTypes
  return clean
}

/**
 * Pipeline-pass-through transform. Strips parser sentinels AND
 * restores correctAnswer on text questions from __aiCorrectAnswer
 * so the downstream collectAiGradedSpecs (PR #234) sees what it
 * expects. fetch-tutorials.ts will strip correctAnswer again from
 * the public emission for AI-graded text questions — that strip
 * happens AFTER collectAiGradedSpecs runs.
 */
function materializeForPipeline(q: ValidationQuestion): ValidationQuestion {
  const clean: any = { ...q }
  delete clean.__autoauthor
  delete clean.__directiveTypes
  if (q.type === QUESTION_TYPE_TEXT && q.__aiCorrectAnswer != null) {
    clean.correctAnswer = q.__aiCorrectAnswer
    delete clean.__aiCorrectAnswer
  }
  return clean
}
