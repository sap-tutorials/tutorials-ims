#!/usr/bin/env tsx
// scripts/aggregate-ai-quiz-eval.ts
//
// Reads filled CSV(s) from scripts/evaluate-ai-quizzes.ts, prints a
// would-ship report. Drives the spike's graduate / iterate / shelve
// decision per the threshold table in the spec.
//
// Usage:
//   npx tsx scripts/aggregate-ai-quiz-eval.ts <csv-glob>
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { readFileSync } from 'node:fs'
import { QUESTION_TYPE_TEXT } from './parsers/types.js'

// Node 20 (project minimum per CLAUDE.md) has no built-in glob; we accept
// literal CSV paths instead. Authors typically have a small number of
// per-pilot CSVs; aggregating across many is fine via shell-side wildcards
// the user passes through (the shell expands them before invocation).

export interface FilledRow {
  slug: string
  stepNumber: number
  source: 'hand-authored' | 'ai-authored'
  questionType: 'multiple-choice' | 'text'
  question: string
  correctAnswer: string
  options: string
  authorWouldShip: '' | 'yes' | 'no' | 'maybe'
  authorNotes: string
}

export interface Aggregate {
  tutorialsEvaluated: number
  stepsWithBoth: number
  mcq: { total: number; yes: number; rate: number }
  text: { total: number; yes: number; rate: number }
  overall: { total: number; yes: number; rate: number }
}

export function aggregateRows(rows: FilledRow[]): Aggregate {
  const aiRows = rows.filter(r => r.source === 'ai-authored')
  const tutorials = new Set(rows.map(r => r.slug))
  const stepKeys = new Set(rows.map(r => `${r.slug}#${r.stepNumber}`))

  const buckets = (rs: FilledRow[]) => {
    const total = rs.length
    const yes = rs.filter(r => r.authorWouldShip === 'yes').length
    return { total, yes, rate: total === 0 ? 0 : yes / total }
  }
  return {
    tutorialsEvaluated: tutorials.size,
    stepsWithBoth: stepKeys.size,
    mcq: buckets(aiRows.filter(r => r.questionType === 'multiple-choice')),
    text: buckets(aiRows.filter(r => r.questionType === QUESTION_TYPE_TEXT)),
    overall: buckets(aiRows),
  }
}

/** Tokenize rejection notes — case-insensitive, punctuation-split, substring-frequency.
 *  Enumerates contiguous word n-grams (length >= 2) per fragment so that
 *  short critiques like "too vague" cluster across longer sentences like
 *  "also too vague". Good-enough heuristic for an N=~100 sample (per spec;
 *  not formal NLP). */
export function tokenizeNotes(notes: string[]): Map<string, number> {
  const phrases = new Map<string, number>()
  for (const note of notes) {
    if (!note.trim()) continue
    // Split on punctuation/newline; keep multi-word fragments.
    const fragments = note.toLowerCase().split(/[.,;\n]/).map(s => s.trim()).filter(s => s.length > 3)
    for (const f of fragments) {
      const words = f.split(/\s+/).filter(w => w.length > 0)
      // Generate all contiguous n-grams of length 2..N. This lets a short
      // canonical phrase ("too vague") accumulate count even when it appears
      // inside longer wraps ("also too vague", "answer too vague").
      for (let len = 2; len <= words.length; len++) {
        for (let start = 0; start + len <= words.length; start++) {
          const phrase = words.slice(start, start + len).join(' ')
          phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1)
        }
      }
    }
  }
  return phrases
}

/**
 * Parse a complete CSV file content into FilledRow records. Handles:
 * - quoted fields with embedded commas, newlines, and escaped quotes ("")
 * - both LF and CRLF line endings
 * - normalizes authorWouldShip to canonical lowercase + trimmed at parse time
 *
 * Tier-2 hardening: the previous implementation split on /\r?\n/ before
 * parsing, so quoted fields with embedded newlines corrupted the row stream.
 */
export function parseCSV(content: string): FilledRow[] {
  const records = parseCsvAll(content)
  if (records.length === 0) return []

  const headers = records[0]
  const rows: FilledRow[] = []
  for (let i = 1; i < records.length; i++) {
    const fields = records[i]
    if (fields.length === 1 && fields[0] === '') continue  // skip pure-empty trailing record
    const row: any = {}
    headers.forEach((h, j) => row[h] = fields[j] ?? '')
    row.stepNumber = parseInt(row.stepNumber, 10) || 0
    if (typeof row.authorWouldShip === 'string') {
      row.authorWouldShip = row.authorWouldShip.trim().toLowerCase()
    }
    rows.push(row as FilledRow)
  }
  return rows
}

/**
 * Streaming CSV record parser. Reads `content` once, tracks quote state across
 * line boundaries, emits one string[] per record. RFC-4180-ish: handles quoted
 * commas, escaped quotes (""), embedded newlines inside quoted fields, and
 * both LF + CRLF line endings.
 */
function parseCsvAll(content: string): string[][] {
  const records: string[][] = []
  let cur = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  while (i < content.length) {
    const c = content[i]
    if (inQuotes) {
      if (c === '"' && content[i + 1] === '"') { cur += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      cur += c; i++
    } else {
      if (c === '"') { inQuotes = true; i++; continue }
      if (c === ',') { row.push(cur); cur = ''; i++; continue }
      if (c === '\r' && content[i + 1] === '\n') {
        row.push(cur); records.push(row); cur = ''; row = []; i += 2; continue
      }
      if (c === '\n' || c === '\r') {
        row.push(cur); records.push(row); cur = ''; row = []; i++; continue
      }
      cur += c; i++
    }
  }
  // Flush the final field + record (if non-empty content not terminated by newline).
  if (cur.length > 0 || row.length > 0) {
    row.push(cur)
    records.push(row)
  }
  return records
}

function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error('Usage: tsx scripts/aggregate-ai-quiz-eval.ts <csv-path-or-glob> [...more]')
    process.exit(2)
  }
  const allRows: FilledRow[] = []
  // Each arg is a literal CSV path. Shell-side wildcards (e.g.
  // `verdicts/*.csv`) expand before this script sees them — this is
  // standard Unix behavior and avoids requiring globSync (Node 22+).
  for (const csvPath of args) {
    try {
      allRows.push(...parseCSV(readFileSync(csvPath, 'utf8')))
    } catch (err) {
      console.warn(`[aggregate] skip ${csvPath}:`, (err as Error).message)
    }
  }
  const agg = aggregateRows(allRows)
  const aiRows = allRows.filter(r => r.source === 'ai-authored')
  const noteCounts = [...tokenizeNotes(aiRows.map(r => r.authorNotes)).entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10)

  console.log(`=== AI-authored quiz evaluation ===`)
  console.log(`Tutorials evaluated: ${agg.tutorialsEvaluated}`)
  console.log(`Steps with both hand+AI: ${agg.stepsWithBoth}`)
  console.log(`AI questions reviewed: ${agg.overall.total} (${agg.mcq.total} MCQ, ${agg.text.total} text)`)
  console.log()
  console.log(`By type:`)
  console.log(`  MCQ:   ${agg.mcq.yes} / ${agg.mcq.total} marked "yes" → ${(agg.mcq.rate * 100).toFixed(0)}% would-ship`)
  console.log(`  Text:  ${agg.text.yes} / ${agg.text.total} marked "yes" → ${(agg.text.rate * 100).toFixed(0)}% would-ship`)
  console.log()
  console.log(`Overall: ${agg.overall.yes} / ${agg.overall.total} → ${(agg.overall.rate * 100).toFixed(0)}% would-ship rate`)
  if (noteCounts.length) {
    console.log()
    console.log(`Most-common rejection notes (text frequency):`)
    for (const [phrase, count] of noteCounts) console.log(`  - "${phrase}" (${count})`)
  }
}

import { pathToFileURL } from 'node:url'
const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isDirect) main()
