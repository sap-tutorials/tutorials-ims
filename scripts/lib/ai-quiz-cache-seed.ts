// scripts/lib/ai-quiz-cache-seed.ts
//
// Deploy-time guard against silent cold AI-quiz regeneration.
//
// The AI-quiz cache lives at .tutorial-cache/<slug>.ai-quiz-cache.json and is
// git-ignored, so it's worktree-local. In CI, actions/cache@v4 restores the
// whole .tutorial-cache/ dir (fetch-tutorials.ts ~line 1795), so the cache is
// warm. But a LOCAL deploy from a FRESH worktree (the canonical emergency /
// ad-hoc deploy path) starts with an empty .tutorial-cache/, forcing every
// [AUTOAUTHOR_*] tutorial to regenerate its quiz from the LLM — a ~30-minute
// cold full rebuild that looks like "the deploy is just slow".
//
// This guard:
//   1. Counts warm AI-quiz cache files already in the active cache dir.
//   2. If cold, seeds them from a primary-tree cache dir when one exists
//      (worktree-local deploys inherit the main checkout's warm cache).
//   3. Emits a loud, unmissable warning when the cache is still cold after
//      seeding, so a cold regen is a conscious choice, never a silent surprise.
//
// Pure over its inputs where it matters: all filesystem access goes through the
// injected `fs` shim so the unit test runs without touching disk.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Suffix identifying an AI-quiz cache sidecar file. */
export const AI_QUIZ_CACHE_SUFFIX = '.ai-quiz-cache.json'

/**
 * Minimal filesystem surface the guard needs. Injectable so tests pass an
 * in-memory fake and never touch disk.
 */
export interface SeedFs {
  existsSync: (p: string) => boolean
  mkdirSync: (p: string, opts: { recursive: true }) => void
  readdirSync: (p: string) => string[]
  copyFileSync: (src: string, dest: string) => void
}

const realFs: SeedFs = { existsSync, mkdirSync, readdirSync, copyFileSync }

export interface SeedResult {
  /** AI-quiz cache files already present in the active cache dir before seeding. */
  warmBefore: number
  /** Files copied in from the primary tree this run. */
  seeded: number
  /** AI-quiz cache files present after seeding. */
  warmAfter: number
  /** True when the cache is still effectively empty after seeding. */
  cold: boolean
  /** Human-readable one-line summary for the build log. */
  message: string
}

/** Count `*.ai-quiz-cache.json` files in `dir` (0 if the dir doesn't exist). */
function countQuizCacheFiles(fs: SeedFs, dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith(AI_QUIZ_CACHE_SUFFIX))
}

/**
 * Seed the active AI-quiz cache from a primary-tree cache when the active one
 * is cold, and report whether a cold regen is about to happen.
 *
 * @param activeCacheDir  The channel's cache dir (fetch-tutorials CACHE_DIR).
 * @param primaryCacheDir Optional path to the primary checkout's cache dir to
 *                        seed from. When undefined/missing, no seeding occurs.
 * @param opts.fs         Injectable fs (defaults to node:fs).
 * @param opts.coldThreshold Files at-or-below this count count as "cold"
 *                        (default 0 — only a truly empty cache is cold).
 */
export function seedAiQuizCache(
  activeCacheDir: string,
  primaryCacheDir: string | undefined,
  opts: { fs?: SeedFs; coldThreshold?: number } = {},
): SeedResult {
  const fs = opts.fs ?? realFs
  const coldThreshold = opts.coldThreshold ?? 0

  const before = countQuizCacheFiles(fs, activeCacheDir)
  const warmBefore = before.length

  let seeded = 0
  // Only seed when the active cache is cold AND a distinct primary cache exists.
  if (
    warmBefore <= coldThreshold &&
    primaryCacheDir &&
    primaryCacheDir !== activeCacheDir &&
    fs.existsSync(primaryCacheDir)
  ) {
    const donors = countQuizCacheFiles(fs, primaryCacheDir)
    if (donors.length > 0) {
      fs.mkdirSync(activeCacheDir, { recursive: true })
      const existing = new Set(before)
      for (const f of donors) {
        if (existing.has(f)) continue // don't clobber an entry already present
        fs.copyFileSync(join(primaryCacheDir, f), join(activeCacheDir, f))
        seeded++
      }
    }
  }

  const warmAfter = warmBefore + seeded
  const cold = warmAfter <= coldThreshold

  let message: string
  if (seeded > 0) {
    message = `[ai-quiz-cache] seeded ${seeded} cache file(s) from ${primaryCacheDir} (${warmAfter} warm now)`
  } else if (cold) {
    message =
      `[ai-quiz-cache] ⚠️  COLD CACHE — ${warmAfter} AI-quiz cache files present. ` +
      `Every [AUTOAUTHOR_*] tutorial will regenerate from the LLM this run ` +
      `(can take ~30 min on a full rebuild). ` +
      (primaryCacheDir
        ? `No warm cache found at ${primaryCacheDir} to seed from.`
        : `Set AI_QUIZ_CACHE_SEED_DIR to a warm primary-tree cache to avoid this.`)
  } else {
    message = `[ai-quiz-cache] warm — ${warmAfter} AI-quiz cache files present, no seeding needed`
  }

  return { warmBefore, seeded, warmAfter, cold, message }
}

/**
 * Best-effort auto-detect of the primary-checkout cache dir to seed from, for
 * the common "deploy from a fresh git worktree" path. When `activeCacheDir`
 * lives inside a `.claude/worktrees/<name>/` checkout, the main repo root is
 * the path up to (and excluding) `.claude/worktrees/<name>`, and the primary
 * cache is the same trailing cache-dir name under that root.
 *
 * Returns undefined when the active dir isn't inside a worktree (nothing to
 * auto-detect — the caller then relies on AI_QUIZ_CACHE_SEED_DIR or warns).
 *
 * Pure string transform; does not touch the filesystem (seedAiQuizCache
 * validates existence).
 *
 * @param activeCacheDir Absolute path to the active channel cache dir.
 */
export function autoDetectPrimaryCacheDir(activeCacheDir: string): string | undefined {
  const norm = activeCacheDir.replace(/\\/g, '/')
  // Match ".../.claude/worktrees/<name>/<...>/<cacheDirName>"
  const m = norm.match(/^(.*?)\/\.claude\/worktrees\/[^/]+\/(.*)$/)
  if (!m) return undefined
  const [, mainRoot, tail] = m
  // `tail` is the worktree-relative path of the cache dir (e.g. ".tutorial-cache"
  // or a nested one). The primary tree holds it at the same relative location.
  const primary = `${mainRoot}/${tail}`
  // Guard against returning the active dir itself (shouldn't happen, but safe).
  return primary === norm ? undefined : primary
}
