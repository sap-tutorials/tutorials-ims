#!/usr/bin/env tsx
// scripts/evaluate-ai-quizzes.ts
//
// CSV emitter for the #208 evaluation harness. Reads pilot-slug
// AI quiz caches + hand-authored [VALIDATE_N] questions, emits a
// side-by-side CSV the author hand-grades.
//
// Usage:
//   npx tsx scripts/evaluate-ai-quizzes.ts --slugs slug-a,slug-b --output verdicts/eval.csv [--mode paired|ai-only|all] [--types mcq|text|both]
//
// --mode paired  (default) — emit pairs only for steps with BOTH hand and AI questions (apples-to-apples comparison).
// --mode ai-only           — emit all AI questions; skip hand. Use for gap-filling pilots.
// --mode all               — emit everything: hand + AI rows regardless of pairing.
//
// Outputs CSV with columns:
//   slug, stepNumber, source, questionType, question, correctAnswer,
//   options, authorWouldShip, authorNotes
//
// The author fills in authorWouldShip (yes/no/maybe) + authorNotes;
// scripts/aggregate-ai-quiz-eval.ts reads the filled CSV and prints
// the would-ship report.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseRulesVrEnriched } from './parsers/rules.js'
import { loadAiQuizCache } from './lib/ai-quiz-cache.js'
import type { ValidationQuestion } from './parsers/types.js'
import { QUESTION_TYPE_TEXT } from './parsers/types.js'

export interface EvalInputs {
  slug: string
  handAuthored: Map<number, ValidationQuestion[]>
  aiAuthored: Map<number, ValidationQuestion[]>
}

export interface EvalRow {
  slug: string
  stepNumber: number
  source: 'hand-authored' | 'ai-authored'
  questionType: 'multiple-choice' | 'text'
  question: string
  correctAnswer: string
  options: string  // pipe-separated
  authorWouldShip: ''  // filled by reviewer
  authorNotes: ''      // filled by reviewer
}

export type EvalMode = 'paired' | 'ai-only' | 'all'

/**
 * Pure helper — emits one row per question per step, controlled by `mode`:
 *   - 'paired' (default): only emit steps that have BOTH hand AND AI questions
 *     (apples-to-apples comparison case).
 *   - 'ai-only': emit every AI-authored question; ignore hand-authored entirely
 *     (gap-filling pilot case where AI fills steps that lack hand validates).
 *   - 'all': emit everything — hand + AI — regardless of pairing.
 */
export function buildEvalRows(inputs: EvalInputs, mode: EvalMode = 'paired'): EvalRow[] {
  const rows: EvalRow[] = []
  const allStepNums = new Set<number>([
    ...inputs.handAuthored.keys(),
    ...inputs.aiAuthored.keys(),
  ])
  for (const stepNum of [...allStepNums].sort((a, b) => a - b)) {
    const hand = inputs.handAuthored.get(stepNum) ?? []
    const ai = inputs.aiAuthored.get(stepNum) ?? []

    if (mode === 'paired') {
      // Existing behavior: only emit when both hand AND AI exist for this step.
      if (hand.length === 0 || ai.length === 0) continue
      for (const q of hand) rows.push(toRow(inputs.slug, stepNum, 'hand-authored', q))
      for (const q of ai) rows.push(toRow(inputs.slug, stepNum, 'ai-authored', q))
    } else if (mode === 'ai-only') {
      // Gap-filling use case: emit only AI rows; ignore hand.
      for (const q of ai) rows.push(toRow(inputs.slug, stepNum, 'ai-authored', q))
    } else if (mode === 'all') {
      // Emit everything, regardless of pairing.
      for (const q of hand) rows.push(toRow(inputs.slug, stepNum, 'hand-authored', q))
      for (const q of ai) rows.push(toRow(inputs.slug, stepNum, 'ai-authored', q))
    }
  }
  return rows
}

function toRow(
  slug: string,
  stepNumber: number,
  source: 'hand-authored' | 'ai-authored',
  q: ValidationQuestion,
): EvalRow {
  // For AI-authored text questions, the correctAnswer is in __aiCorrectAnswer
  // (the public ValidationQuestion shape strips correctAnswer per #209 anti-leak).
  const correctAnswer = q.__aiCorrectAnswer ?? q.correctAnswer ?? ''
  return {
    slug,
    stepNumber,
    source,
    questionType: q.type,
    question: q.question,
    correctAnswer,
    options: (q.options ?? []).join(' | '),
    authorWouldShip: '',
    authorNotes: '',
  }
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function rowsToCSV(rows: EvalRow[]): string {
  const headers = ['slug', 'stepNumber', 'source', 'questionType', 'question', 'correctAnswer', 'options', 'authorWouldShip', 'authorNotes']
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      csvEscape(r.slug),
      String(r.stepNumber),
      r.source,
      r.questionType,
      csvEscape(r.question),
      csvEscape(r.correctAnswer),
      csvEscape(r.options),
      r.authorWouldShip,
      r.authorNotes,
    ].join(','))
  }
  return lines.join('\n') + '\n'
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { slugs: string[]; output: string; types: 'mcq' | 'text' | 'both'; mode: EvalMode } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      args.set(key, argv[i + 1] ?? '')
      i++
    }
  }
  const slugs = (args.get('slugs') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const output = args.get('output') ?? ''
  const types = (args.get('types') ?? 'both') as 'mcq' | 'text' | 'both'
  const modeArg = (args.get('mode') ?? 'paired') as EvalMode
  if (!['paired', 'ai-only', 'all'].includes(modeArg)) {
    console.error(`Invalid --mode: ${modeArg} (expected paired|ai-only|all)`)
    process.exit(2)
  }
  if (!slugs.length || !output) {
    console.error('Usage: tsx scripts/evaluate-ai-quizzes.ts --slugs <comma-list> --output <path> [--types mcq|text|both] [--mode paired|ai-only|all]')
    process.exit(2)
  }
  return { slugs, output, types, mode: modeArg }
}

async function main() {
  const { slugs, output, types, mode } = parseArgs(process.argv.slice(2))
  const allRows: EvalRow[] = []

  for (const slug of slugs) {
    // Read hand-authored from cached rules.vr
    const rulesPath = join('.tutorial-cache', `${slug}.rules.vr`)
    if (!existsSync(rulesPath)) {
      console.warn(`[evaluate] missing rules.vr cache for ${slug} (run fetch-tutorials first)`)
      continue
    }
    const rulesContent = readFileSync(rulesPath, 'utf8')
    const { map: handAuthored } = parseRulesVrEnriched(rulesContent)

    // Read AI-authored from cache file
    const aiCache = loadAiQuizCache(slug)
    const aiAuthored = new Map<number, ValidationQuestion[]>()
    for (const [stepNumStr, entry] of Object.entries(aiCache.entries)) {
      aiAuthored.set(parseInt(stepNumStr, 10), entry.questions)
    }

    // Filter by --types
    const filterFn = (q: ValidationQuestion) => {
      if (types === 'both') return true
      if (types === 'mcq') return q.type === 'multiple-choice'
      if (types === 'text') return q.type === QUESTION_TYPE_TEXT
      return true
    }
    for (const [stepNum, qs] of handAuthored) handAuthored.set(stepNum, qs.filter(filterFn))
    for (const [stepNum, qs] of aiAuthored) aiAuthored.set(stepNum, qs.filter(filterFn))

    allRows.push(...buildEvalRows({ slug, handAuthored, aiAuthored }, mode))
  }

  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, rowsToCSV(allRows))
  console.log(`[evaluate] wrote ${allRows.length} rows across ${slugs.length} slugs → ${output}`)
}

// ESM entry guard — see scripts/check-build-collisions.ts pattern (#255)
import { pathToFileURL } from 'node:url'
const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isDirect) main()
