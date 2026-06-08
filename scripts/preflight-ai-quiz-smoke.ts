// scripts/preflight-ai-quiz-smoke.ts
//
// Pre-go-live smoke check for the AI-quiz pipeline (#278).
//
// Samples a fraction of the tutorial catalog, spawns
// `cds bind --exec -- npm run fetch-tutorials -- --target hugo` per slug
// with `AI_AUTHOR_ENABLED=true TUTORIAL_SLUG=<slug>`, then runs the five
// invariant helpers from `lib/ai-quiz-invariants` against each tutorial's
// `.tutorial-cache/<slug>.ai-quiz-cache.json`.
//
// Outputs a verdict JSON at `verdicts/preflight-smoke.json` and exits with
// code 0 (safe to graduate), 2 (invariant violations), or 3 (unexpected).
//
// Validation history:
//   - 2026-06-08: initial 5-slug end-to-end run on seed 99 (Task 12).

import type { InvariantName, InvariantResult } from './lib/ai-quiz-invariants'

// ---------------------------------------------------------------------------
// sampleSlugs — reproducible Fisher-Yates partial shuffle over a sorted catalog
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sampleSlugs(catalog: readonly string[], n: number, seed: number): string[] {
  if (n <= 0) return []
  // Sort first so seed → output is stable across catalog orderings (e.g.
  // an operator running this on a freshly-discovered catalog gets the
  // same sample as someone running on a months-old discovery map).
  const sorted = [...catalog].sort()
  if (n >= sorted.length) return sorted
  const rng = mulberry32(seed)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (sorted.length - i))
    ;[sorted[i], sorted[j]] = [sorted[j], sorted[i]]
  }
  return sorted.slice(0, n)
}

// ---------------------------------------------------------------------------
// extractSummaryLine — find the [ai-author] expanded directives line
// ---------------------------------------------------------------------------

const SUMMARY_LINE_PREFIX = '[ai-author] expanded directives across all tutorials:'

export function extractSummaryLine(stdout: string): string | null {
  const lines = stdout.split('\n')
  // Walk from the end so we capture the last (most recent) occurrence —
  // matters when the subprocess somehow emits the line twice.
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith(SUMMARY_LINE_PREFIX)) return trimmed
  }
  return null
}

// ---------------------------------------------------------------------------
// summarizeVerdict — fold per-tutorial rows into the JSON artifact shape
// ---------------------------------------------------------------------------

export interface PerTutorialRow {
  slug: string
  results: InvariantResult[]
  durationMs: number
  /** Only set when the subprocess crashed before any invariant could run. */
  fatalError?: string
}

export interface Verdict {
  safeToGraduate: boolean
  totals: { passed: number; failed: number; total: number }
  failedSlugs: string[]
  failuresByInvariant: Record<InvariantName, number>
  rows: PerTutorialRow[]
  generatedAt: string
}

export function summarizeVerdict(rows: PerTutorialRow[]): Verdict {
  const failuresByInvariant: Record<InvariantName, number> = {
    'no-upstream-errors': 0,
    precedence: 0,
    'anti-leak': 0,
    'mcq-shape': 0,
    'generator-sanity': 0,
  }
  const failedSlugs: string[] = []
  let passed = 0
  for (const row of rows) {
    const rowFailed = row.fatalError !== undefined || row.results.some(r => !r.passed)
    if (rowFailed) {
      failedSlugs.push(row.slug)
      for (const r of row.results) {
        if (!r.passed) failuresByInvariant[r.name]++
      }
    } else {
      passed++
    }
  }
  return {
    safeToGraduate: failedSlugs.length === 0,
    totals: { passed, failed: failedSlugs.length, total: rows.length },
    failedSlugs,
    failuresByInvariant,
    rows,
    generatedAt: new Date().toISOString(),
  }
}
