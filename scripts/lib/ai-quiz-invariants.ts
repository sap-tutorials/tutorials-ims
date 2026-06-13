// scripts/lib/ai-quiz-invariants.ts
//
// Shared type contracts for the AI-quiz smoke-check invariant helpers.
// Type-only module — no logic. Consumed by Tasks 2-7 (invariant helpers)
// and Task 11 (smoke runner).
//
// Issue: #278 — pre-go-live AI-quiz smoke check

import type { AiQuizCache, AiQuizCacheEntry } from './ai-quiz-cache'
import type { ValidationQuestion } from '../parsers/types'

export type InvariantName =
  | 'no-upstream-errors'
  | 'precedence'
  | 'anti-leak'
  | 'mcq-shape'
  | 'generator-sanity'

export interface InvariantResult {
  name: InvariantName
  passed: boolean
  /** Empty when passed=true; one-line human reason when passed=false. */
  reason?: string
  /** Optional structured details (step number, question id, etc.) for the JSON artifact. */
  details?: Record<string, unknown>
}

export interface InvariantInput {
  slug: string
  cache: AiQuizCache
  /** Set of step numbers that have ANY [VALIDATE_N] block. From parseRulesVrEnriched. */
  handAuthoredSteps: Set<number>
  /** The single line emitted at end-of-build by `scripts/fetch-tutorials.ts`, starting with the literal prefix `[ai-author] expanded directives`. */
  summaryLine: string | null
  /** Current expected promptVersion. Defaults to PROMPT_VERSION constant, overridable for forward-compat tests. */
  expectedPromptVersion?: string
}

// Re-export the referenced types so invariant-helper files can import
// AiQuizCacheEntry and ValidationQuestion from a single location if needed.
export type { AiQuizCache, AiQuizCacheEntry, ValidationQuestion }

// ---------------------------------------------------------------------------
// Invariant 1: no-upstream-errors
// ---------------------------------------------------------------------------

// [#311] Summary line gained an "<n> empty-step skipped" token between
// errors and Build cap. The skip count is optional in the regex so older
// fetch-tutorials.ts logs (without #311's guard) still parse cleanly.
const SUMMARY_REGEX = /^\[ai-author\] expanded directives across all tutorials: (\d+) cache miss \(LLM call\), (\d+) cache hit, (\d+) errors(?:, (\d+) empty-step skipped)?\. Build cap: \d+\.$/

export function invariantNoUpstreamErrors(summaryLine: string | null): InvariantResult {
  const name: InvariantName = 'no-upstream-errors'
  if (summaryLine === null) {
    return { name, passed: false, reason: 'no [ai-author] summary line captured (subprocess may have crashed before emit)' }
  }
  const match = summaryLine.match(SUMMARY_REGEX)
  if (!match) {
    return { name, passed: false, reason: `could not parse summary line: ${summaryLine}` }
  }
  const errors = Number(match[3])
  if (errors > 0) {
    return { name, passed: false, reason: `${errors} errors reported in summary`, details: { errors, miss: Number(match[1]), hit: Number(match[2]) } }
  }
  return { name, passed: true, details: { errors: 0, miss: Number(match[1]), hit: Number(match[2]) } }
}

// ---------------------------------------------------------------------------
// Invariant 2: precedence
//   For every step number in `handAuthoredSteps`, the cache MUST NOT contain
//   an entry. AI must never fire on top of hand-authored content. Catches
//   the PR #277 bug shapes (regex-substring blocks without ###Question, and
//   the case-sensitive [X]/[ ] asymmetry that silently dropped uppercase
//   correct answers).
// ---------------------------------------------------------------------------

export function invariantPrecedence(cache: AiQuizCache, handAuthoredSteps: Set<number>): InvariantResult {
  const name: InvariantName = 'precedence'
  const violating: number[] = []
  for (const stepKey of Object.keys(cache.entries)) {
    const stepNum = Number(stepKey)
    if (Number.isFinite(stepNum) && handAuthoredSteps.has(stepNum)) {
      violating.push(stepNum)
    }
  }
  violating.sort((a, b) => a - b)
  if (violating.length > 0) {
    const label = violating.length === 1 ? 'step' : 'steps'
    return {
      name,
      passed: false,
      reason: `AI questions cached for hand-authored ${label} ${violating.join(', ')}`,
      details: { violatingSteps: violating },
    }
  }
  return { name, passed: true }
}

// ---------------------------------------------------------------------------
// Invariant 3: anti-leak
//   AI-graded text questions MUST have `__aiCorrectAnswer` set (the build-time
//   sentinel) and MUST NOT have `correctAnswer` set (which would leak the
//   reference answer through the public Hugo frontmatter — issue #209).
//   Skips MCQ questions, which legitimately ship `correctAnswer`.
// ---------------------------------------------------------------------------

export function invariantAntiLeak(cache: AiQuizCache): InvariantResult {
  const name: InvariantName = 'anti-leak'
  const violations: Array<{ step: string; questionId: string; reason: string }> = []
  for (const [step, entry] of Object.entries(cache.entries)) {
    for (const q of entry.questions) {
      if (q.type !== 'text') continue
      if (q.correctAnswer !== undefined) {
        violations.push({ step, questionId: q.id, reason: 'correctAnswer set on AI text question (leak)' })
      }
      if (q.__aiCorrectAnswer === undefined || q.__aiCorrectAnswer === '') {
        violations.push({ step, questionId: q.id, reason: '__aiCorrectAnswer missing on AI text question' })
      }
    }
  }
  if (violations.length > 0) {
    return {
      name,
      passed: false,
      reason: violations.map(v => `step ${v.step} q=${v.questionId}: ${v.reason}`).join('; '),
      details: { violations },
    }
  }
  return { name, passed: true }
}

// ---------------------------------------------------------------------------
// Invariant 4: mcq-shape
//   MCQs MUST have 2-4 options and a `correctAnswer` that appears verbatim
//   (case-sensitive, no whitespace trim) in `options`. Catches generator
//   shape regressions before they break the validation widget at runtime.
// ---------------------------------------------------------------------------

export function invariantMcqShape(cache: AiQuizCache): InvariantResult {
  const name: InvariantName = 'mcq-shape'
  const violations: Array<{ step: string; questionId: string; reason: string }> = []
  for (const [step, entry] of Object.entries(cache.entries)) {
    for (const q of entry.questions) {
      if (q.type !== 'multiple-choice') continue
      const options = q.options
      if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
        violations.push({ step, questionId: q.id, reason: `${options?.length ?? 0} options (expected 2–4)` })
        continue
      }
      if (q.correctAnswer === undefined || q.correctAnswer === '') {
        violations.push({ step, questionId: q.id, reason: 'correctAnswer missing' })
        continue
      }
      if (!options.includes(q.correctAnswer)) {
        violations.push({ step, questionId: q.id, reason: `correctAnswer not in options (verbatim)` })
      }
    }
  }
  if (violations.length > 0) {
    return {
      name,
      passed: false,
      reason: violations.map(v => `step ${v.step} q=${v.questionId}: ${v.reason}`).join('; '),
      details: { violations },
    }
  }
  return { name, passed: true }
}

// ---------------------------------------------------------------------------
// Invariant 5: generator-sanity
//   When the cache has any entries: `promptVersion` must match the expected
//   value and `modelName` must be non-empty. Every entry (regardless of
//   cache size) must contain at least one question. Catches generator
//   regressions where the LLM round-trips empty payloads or stale prompts.
// ---------------------------------------------------------------------------

export function invariantGeneratorSanity(cache: AiQuizCache, expectedPromptVersion: string): InvariantResult {
  const name: InvariantName = 'generator-sanity'
  const hasEntries = Object.keys(cache.entries).length > 0
  if (hasEntries) {
    if (cache.promptVersion !== expectedPromptVersion) {
      return { name, passed: false, reason: `promptVersion ${cache.promptVersion} != expected ${expectedPromptVersion}` }
    }
    if (!cache.modelName || cache.modelName.length === 0) {
      return { name, passed: false, reason: 'modelName empty on non-empty cache' }
    }
  }
  const empties: string[] = []
  for (const [step, entry] of Object.entries(cache.entries)) {
    if (entry.questions.length === 0) empties.push(step)
  }
  if (empties.length > 0) {
    return { name, passed: false, reason: `entries with 0 questions: ${empties.join(', ')}`, details: { emptySteps: empties } }
  }
  return { name, passed: true }
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * The current prompt version emitted by the AI-quiz generator.
 * Mirrors `PROMPT_VERSION` in `srv/lib/ai-quiz-generator.js`. When the
 * generator's prompt is rev'd, bump this to match — the generator-sanity
 * invariant uses this as the default expected value.
 */
export const CURRENT_PROMPT_VERSION = 'v1'

export function runAllInvariants(input: InvariantInput): InvariantResult[] {
  const expected = input.expectedPromptVersion ?? CURRENT_PROMPT_VERSION
  return [
    invariantNoUpstreamErrors(input.summaryLine),
    invariantPrecedence(input.cache, input.handAuthoredSteps),
    invariantAntiLeak(input.cache),
    invariantMcqShape(input.cache),
    invariantGeneratorSanity(input.cache, expected),
  ]
}
