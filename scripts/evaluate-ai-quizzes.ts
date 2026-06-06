#!/usr/bin/env tsx
// scripts/evaluate-ai-quizzes.ts
//
// CSV emitter for the #208 evaluation harness. Reads pilot-slug
// AI quiz caches + hand-authored [VALIDATE_N] questions, emits a
// side-by-side CSV the author hand-grades.
//
// Usage:
//   npx tsx scripts/evaluate-ai-quizzes.ts --slugs slug-a,slug-b --output verdicts/eval.csv [--types both]
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

/**
 * Pure helper — emits one row per question for steps that have BOTH
 * hand-authored AND AI-authored questions (the comparison case).
 */
export function buildEvalRows(inputs: EvalInputs): EvalRow[] {
  const rows: EvalRow[] = []
  for (const [stepNum, hand] of inputs.handAuthored) {
    if (hand.length === 0) continue
    const ai = inputs.aiAuthored.get(stepNum) ?? []
    if (ai.length === 0) continue  // only emit steps that have BOTH
    for (const q of hand) rows.push(toRow(inputs.slug, stepNum, 'hand-authored', q))
    for (const q of ai) rows.push(toRow(inputs.slug, stepNum, 'ai-authored', q))
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
  const correctAnswer = (q as any).__aiCorrectAnswer ?? q.correctAnswer ?? ''
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

function parseArgs(argv: string[]): { slugs: string[]; output: string; types: 'mcq' | 'text' | 'both' } {
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
  if (!slugs.length || !output) {
    console.error('Usage: tsx scripts/evaluate-ai-quizzes.ts --slugs <comma-list> --output <path> [--types mcq|text|both]')
    process.exit(2)
  }
  return { slugs, output, types }
}

async function main() {
  const { slugs, output, types } = parseArgs(process.argv.slice(2))
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
      if (types === 'text') return q.type === 'text'
      return true
    }
    for (const [stepNum, qs] of handAuthored) handAuthored.set(stepNum, qs.filter(filterFn))
    for (const [stepNum, qs] of aiAuthored) aiAuthored.set(stepNum, qs.filter(filterFn))

    allRows.push(...buildEvalRows({ slug, handAuthored, aiAuthored }))
  }

  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, rowsToCSV(allRows))
  console.log(`[evaluate] wrote ${allRows.length} rows across ${slugs.length} slugs → ${output}`)
}

// ESM entry guard — see scripts/check-build-collisions.ts pattern (#255)
import { pathToFileURL } from 'node:url'
const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isDirect) main()
