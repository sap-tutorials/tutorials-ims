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

const SUMMARY_REGEX = /^\[ai-author\] expanded directives across all tutorials: (\d+) cache miss \(LLM call\), (\d+) cache hit, (\d+) errors\. Build cap: \d+\.$/

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
