// scripts/publish/publish-contributors.ts
// Non-fatal auxiliary publish step for issue #WS2.
// Reads `*.contributors.json` sidecar files from `cacheDir` (emitted by
// scripts/fetch-tutorials.ts) and publishes them to CAP.
//
// Auth: CONTENT_API_KEY via contentAuthMiddleware (Authorization: Bearer).
// Failures are NON-FATAL — captured and returned to the caller.
//
// Perf history:
//   #2462 — was O(full catalog) sequential per-file POSTs on every publish.
//           Added a `slugs` filter (publish only changed slugs) + concurrency.
//   #2463 — bulk endpoint: the surviving sidecars are sent as batched
//           { items: [...] } POSTs instead of one request per file.
//   #2464 — delta-skip by hash: fetch the server's {slug: hash} feed and drop
//           any sidecar whose canonical hash already matches the stored rows,
//           so a full publish re-sends only genuinely-changed sidecars.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runConcurrent, chunk } from '../lib/publish-batcher.js'
import { hashContributors } from '../../srv/lib/sidecar-hash.js'

const SUFFIX = '.contributors.json'
const CONCURRENCY = 6
// Slugs per bulk POST. Bounded so each request body stays modest and one failed
// batch loses only BATCH slugs, not the whole publish.
const BATCH = 200

interface SidecarItem { slug: string; contributors: unknown[] }

/** Resolve the candidate sidecar filenames (slug-filtered or whole-cache). */
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

/**
 * Fetch the server's {slug: hash} contributor feed (#2464). Fails soft to `{}`
 * (publish everything) on any error, 404 (route not deployed yet), or 503.
 */
async function fetchRemoteHashes(baseUrl: string, apiKey: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${baseUrl}/content/contributor-hashes`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    })
    if (!res.ok) return {}
    return (await res.json()) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Publish contributor sidecars.
 *
 * @param opts.slugs  Optional changed-slug allowlist. When provided, only those
 *                    slugs' sidecars are considered. When omitted, the whole
 *                    cache is considered (then hash-filtered).
 * @returns { published, total, skipped } — published = slugs sent; skipped =
 *          dropped because their hash already matched; total = candidates that
 *          had a readable sidecar.
 */
export async function publishContributors(opts: {
  cacheDir: string
  baseUrl: string
  apiKey: string
  slugs?: string[]
}): Promise<{ published: number; total: number; skipped: number }> {
  const { cacheDir, baseUrl, apiKey, slugs } = opts
  const files = resolveFiles(cacheDir, slugs)
  if (files.length === 0) return { published: 0, total: 0, skipped: 0 }

  // Read + parse each sidecar. Unreadable/malformed files are skipped (non-fatal).
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
      if (parsed && parsed.slug && Array.isArray(parsed.contributors)) {
        items.push({ slug: String(parsed.slug), contributors: parsed.contributors })
      }
    } catch {
      console.warn(`[publish-contributors] malformed sidecar skipped: ${f}`)
    }
  }
  const total = items.length
  if (total === 0) return { published: 0, total: 0, skipped: 0 }

  // #2464 — drop sidecars whose canonical hash already matches the server.
  const remote = await fetchRemoteHashes(baseUrl, apiKey)
  const changed = items.filter((it) => {
    const local = hashContributors(it.contributors as any[])
    return remote[it.slug.toLowerCase()] !== local
  })
  const skipped = total - changed.length
  if (changed.length === 0) return { published: 0, total, skipped }

  // #2463 — send survivors as batched bulk POSTs at bounded concurrency. Each
  // batch task is non-throwing (runConcurrent aborts the whole run on a throw).
  const batches = chunk(changed, BATCH)
  const tasks = batches.map((batch) => async (): Promise<number> => {
    let res: Response
    try {
      res = await fetch(`${baseUrl}/content/publish-contributors-bulk`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ items: batch }),
      })
    } catch (err) {
      console.warn('[publish-contributors] bulk network error:', (err as Error).message)
      return 0
    }
    if (!res.ok) {
      console.warn(`[publish-contributors] bulk -> ${res.status}`)
      return 0
    }
    return batch.length
  })

  const counts = await runConcurrent(tasks, CONCURRENCY)
  const published = counts.reduce((a, b) => a + b, 0)
  return { published, total, skipped }
}
