// scripts/lib/challenge-spec-cache.ts
//
// Content-hash cache over per-tutorial sidecar files at
// .tutorial-cache/<slug>.challenge-spec-cache.json. Sibling to
// <slug>.ai-quiz-cache.json + <slug>.challenge-answers.json.
//
// Mirrors scripts/lib/ai-quiz-cache.ts (the AI-quiz path this clones): without
// it, every flag-on rebuild regenerates every challenge spec from the model —
// cost + per-build nondeterminism (#2441 gate 2). A cache HIT reconstructs both
// the public spec (step.challenge) AND the freeText referenceAnswers sidecar
// with no model call.
//
// Hash key uses \x00 (NUL) as the field separator — step bodies are UTF-8
// markdown which never contain a literal NUL, so it is a safe sentinel that
// prevents concatenation collisions. The key folds in promptVersion + modelName
// so a PROMPT_VERSION bump or model swap invalidates every entry.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The public (answer-stripped) challenge spec and the server-only reference
// answers, exactly as srv/lib/ai-challenge-spec.js's generateChallengeSpec
// returns them. Kept structural (not imported) — ai-challenge-spec.js is plain
// JS with no exported types.
export interface ChallengeSpecCacheEntry {
  stepHash: string
  generatedAt: string
  spec: { nodes: unknown[] }
  referenceAnswers: Array<{ nodeId: string; reference: string }>
}

export interface ChallengeSpecCache {
  promptVersion: string
  modelName: string
  entries: Record<string, ChallengeSpecCacheEntry>  // keyed by step number (as string)
}

const SEP = '\x00'

export function hashKey(input: {
  stepBody: string
  promptVersion: string
  modelName: string
}): string {
  return createHash('sha256')
    .update([input.stepBody, input.promptVersion, input.modelName].join(SEP))
    .digest('hex')
}

const DEFAULT_CACHE_DIR = process.env.TUTORIAL_CACHE_DIR ?? '.tutorial-cache'

function cachePath(slug: string, cacheDir = DEFAULT_CACHE_DIR): string {
  return join(cacheDir, `${slug.toLowerCase()}.challenge-spec-cache.json`)
}

export function loadChallengeSpecCache(slug: string, opts: { cacheDir?: string } = {}): ChallengeSpecCache {
  const path = cachePath(slug, opts.cacheDir)
  if (!existsSync(path)) {
    return { promptVersion: 'v1', modelName: '', entries: {} }
  }
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw) as ChallengeSpecCache
}

export function saveChallengeSpecCache(
  slug: string,
  cache: ChallengeSpecCache,
  opts: { cacheDir?: string } = {},
): void {
  const path = cachePath(slug, opts.cacheDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2))
}
