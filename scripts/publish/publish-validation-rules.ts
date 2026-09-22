// scripts/publish/publish-validation-rules.ts
// Non-fatal auxiliary publish step for issue #WS3.
// Reads `*.validation-rules.json` sidecar files from `cacheDir` (emitted by
// scripts/fetch-tutorials.ts) and publishes them to CAP.
//
// Auth: CONTENT_API_KEY via contentAuthMiddleware (Authorization: Bearer).
// Failures are NON-FATAL — captured and returned to the caller.
//
// Perf history (same arc as publish-contributors.ts):
//   #2462 — `slugs` filter + concurrency (was O(catalog) per-file POSTs).
//   #2463 — bulk endpoint: batched { items: [...] } POSTs.
//   #2464 — delta-skip by hash: fetch the server's {slug: hash} feed and drop
//           sidecars whose canonical hash already matches.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runConcurrent, chunk } from '../lib/publish-batcher.js'
import { hashValidationRules } from '../../srv/lib/sidecar-hash.js'

const SUFFIX = '.validation-rules.json'
const CONCURRENCY = 6
const BATCH = 200

interface SidecarItem { slug: string; rules: unknown[] }

function resolveFiles(cacheDir: string, slugs?: string[]): string[] {
  if (slugs) {
    const wanted = new Set(slugs.map((s) => `${s}${SUFFIX}`))
    let present: Set<string>
    try {
      present = new Set(readdirSync(cacheDir).filter((f) => f.endsWith(SUFFIX)))
    } catch {
      return []
    }
    return [...wanted].filter((f) => present.has(f))
  }
  try {
    return readdirSync(cacheDir).filter((f) => f.endsWith(SUFFIX))
  } catch {
    return []
  }
}

/** Fetch the server's {slug: hash} validation-rules feed (#2464). Fails soft to {}. */
async function fetchRemoteHashes(baseUrl: string, apiKey: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${baseUrl}/content/validation-rule-hashes`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    })
    if (!res.ok) return {}
    return (await res.json()) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Publish validation-rules sidecars.
 *
 * @param opts.slugs  Optional changed-slug allowlist.
 * @returns { published, total, skipped }
 */
export async function publishValidationRules(opts: {
  cacheDir: string
  baseUrl: string
  apiKey: string
  slugs?: string[]
}): Promise<{ published: number; total: number; skipped: number }> {
  const { cacheDir, baseUrl, apiKey, slugs } = opts
  const files = resolveFiles(cacheDir, slugs)
  if (files.length === 0) return { published: 0, total: 0, skipped: 0 }

  const items: SidecarItem[] = []
  for (const f of files) {
    let raw: string
    try {
      raw = readFileSync(join(cacheDir, f), 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.slug && Array.isArray(parsed.rules)) {
        items.push({ slug: String(parsed.slug), rules: parsed.rules })
      }
    } catch {
      console.warn(`[publish-validation-rules] malformed sidecar skipped: ${f}`)
    }
  }
  const total = items.length
  if (total === 0) return { published: 0, total: 0, skipped: 0 }

  const remote = await fetchRemoteHashes(baseUrl, apiKey)
  const changed = items.filter((it) => {
    const local = hashValidationRules(it.rules as any[])
    return remote[it.slug.toLowerCase()] !== local
  })
  const skipped = total - changed.length
  if (changed.length === 0) return { published: 0, total, skipped }

  const batches = chunk(changed, BATCH)
  const tasks = batches.map((batch) => async (): Promise<number> => {
    let res: Response
    try {
      res = await fetch(`${baseUrl}/content/publish-validation-rules-bulk`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ items: batch }),
      })
    } catch (err) {
      console.warn('[publish-validation-rules] bulk network error:', (err as Error).message)
      return 0
    }
    if (!res.ok) {
      console.warn(`[publish-validation-rules] bulk -> ${res.status}`)
      return 0
    }
    return batch.length
  })

  const counts = await runConcurrent(tasks, CONCURRENCY)
  const published = counts.reduce((a, b) => a + b, 0)
  return { published, total, skipped }
}
