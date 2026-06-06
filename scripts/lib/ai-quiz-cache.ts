// scripts/lib/ai-quiz-cache.ts
//
// Content-hash cache over per-tutorial sidecar files at
// .tutorial-cache/<slug>.ai-quiz-cache.json. Sibling to
// <slug>.codecheck.json + <slug>.validate-answer.json.
//
// Hash key uses \x00 (NUL byte) as the separator between fields —
// step bodies are UTF-8 markdown which never contain a literal NUL,
// so this is a safe sentinel that prevents concatenation collisions
// between step body endings and directive boundaries.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ValidationQuestion } from '../parsers/types.js'

export interface AiQuizCacheEntry {
  stepHash: string
  directive: string
  types: 'mcq-and-text' | 'mcq-only' | 'text-only'
  generatedAt: string
  questions: ValidationQuestion[]
}

export interface AiQuizCache {
  promptVersion: string
  modelName: string
  entries: Record<string, AiQuizCacheEntry>  // keyed by step number (as string)
}

const SEP = '\x00'

export function hashKey(input: {
  stepBody: string
  directive: string
  types: string
  promptVersion: string
  modelName: string
}): string {
  return createHash('sha256')
    .update([input.stepBody, input.directive, input.types, input.promptVersion, input.modelName].join(SEP))
    .digest('hex')
}

const DEFAULT_CACHE_DIR = process.env.TUTORIAL_CACHE_DIR ?? '.tutorial-cache'

function cachePath(slug: string, cacheDir = DEFAULT_CACHE_DIR): string {
  return join(cacheDir, `${slug.toLowerCase()}.ai-quiz-cache.json`)
}

export function loadAiQuizCache(slug: string, opts: { cacheDir?: string } = {}): AiQuizCache {
  const path = cachePath(slug, opts.cacheDir)
  if (!existsSync(path)) {
    return { promptVersion: 'v1', modelName: '', entries: {} }
  }
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw) as AiQuizCache
}

export function saveAiQuizCache(
  slug: string,
  cache: AiQuizCache,
  opts: { cacheDir?: string } = {},
): void {
  const path = cachePath(slug, opts.cacheDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2))
}
