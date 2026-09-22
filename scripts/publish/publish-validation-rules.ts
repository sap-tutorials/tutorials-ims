// scripts/publish/publish-validation-rules.ts
// Non-fatal auxiliary publish step for issue #WS3.
// Walks `cacheDir` for `*.validation-rules.json` sidecar files emitted by
// scripts/fetch-tutorials.ts and POSTs each one to
// /content/publish-validation-rules (Task 13 REPLACE handler).
//
// Auth: CONTENT_API_KEY via contentAuthMiddleware (Authorization: Bearer).
// Failures are NON-FATAL — captured and returned to the caller.
//
// Perf (#2462): historically this walked the ENTIRE cache and POSTed every
// sidecar sequentially on every publish — O(full catalog) sequential HTTP
// round-trips even for a single-slug hotfix, even though only ~1,091 of ~2,400
// tutorials have any rules. Two fixes:
//   1. `slugs` filter — when the caller passes the changed-slug set (delta /
//      slug-targeted publish), only that slug's sidecar is POSTed (and only if
//      it actually has a rules sidecar). A one-slug hotfix drops from ~1,091
//      POSTs to ≤1. Omitting `slugs` (full publish) preserves the whole-cache
//      walk.
//   2. runConcurrent — the remaining POSTs run at bounded concurrency instead
//      of one-at-a-time, cutting full-publish wall-clock ~CONCURRENCYx.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runConcurrent } from '../lib/publish-batcher.js'

const SUFFIX = '.validation-rules.json'
const CONCURRENCY = 6

/**
 * Walk cacheDir for *.validation-rules.json sidecar files (optionally filtered
 * to a changed-slug set), POST each one to /content/publish-validation-rules at
 * bounded concurrency.
 *
 * @param opts.cacheDir  Tutorial cache dir (e.g. .tutorial-cache)
 * @param opts.baseUrl   CAP base URL
 * @param opts.apiKey    CONTENT_API_KEY value
 * @param opts.slugs     Optional changed-slug allowlist. When provided, only
 *                       `<slug>.validation-rules.json` sidecars for these slugs
 *                       are published. When omitted, the whole cache is
 *                       published.
 * @returns { published, total }
 */
export async function publishValidationRules(opts: {
  cacheDir: string
  baseUrl: string
  apiKey: string
  slugs?: string[]
}): Promise<{ published: number; total: number }> {
  const { cacheDir, baseUrl, apiKey, slugs } = opts

  let files: string[]
  if (slugs) {
    // Slug-targeted: only publish sidecars for changed slugs that actually have
    // a cached rules sidecar. This is the #2462 fix that returns a single-slug
    // hotfix to O(changed) instead of O(full catalog). Most changed slugs have
    // no rules sidecar at all, so this is typically zero POSTs.
    const wanted = new Set(slugs.map((s) => `${s}${SUFFIX}`))
    let present: Set<string>
    try {
      present = new Set(readdirSync(cacheDir).filter((f) => f.endsWith(SUFFIX)))
    } catch {
      return { published: 0, total: 0 }
    }
    files = [...wanted].filter((f) => present.has(f))
  } else {
    try {
      files = readdirSync(cacheDir).filter((f) => f.endsWith(SUFFIX))
    } catch {
      return { published: 0, total: 0 }
    }
  }

  // One self-contained, non-throwing task per file (runConcurrent aborts the
  // whole batch on the first thrown error; these steps are non-fatal, so each
  // task swallows its own error and reports a boolean).
  const tasks = files.map((f) => async (): Promise<boolean> => {
    const filePath = join(cacheDir, f)
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      return false
    }

    let res: Response
    try {
      res = await fetch(`${baseUrl}/content/publish-validation-rules`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: raw,
      })
    } catch (err) {
      console.warn(`[publish-validation-rules] network error for ${f}:`, (err as Error).message)
      return false
    }

    if (res.ok) return true
    console.warn(`[publish-validation-rules] ${f} -> ${res.status}`)
    return false
  })

  const results = await runConcurrent(tasks, CONCURRENCY)
  const published = results.filter(Boolean).length
  return { published, total: files.length }
}
