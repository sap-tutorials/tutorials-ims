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
