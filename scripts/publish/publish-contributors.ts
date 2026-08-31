// scripts/publish/publish-contributors.ts
// Non-fatal auxiliary publish step for issue #WS2.
// Walks `cacheDir` for `*.contributors.json` sidecar files emitted by
// scripts/fetch-tutorials.ts and POSTs each one to
// /content/publish-contributors (Task 6 REPLACE handler).
//
// Auth: CONTENT_API_KEY via contentAuthMiddleware (Authorization: Bearer).
// Failures are NON-FATAL — captured and returned to the caller.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUFFIX = '.contributors.json'

/**
 * Walk cacheDir for *.contributors.json sidecar files,
 * POST each one to /content/publish-contributors.
 *
 * @param opts.cacheDir  Tutorial cache dir (e.g. .tutorial-cache)
 * @param opts.baseUrl   CAP base URL
 * @param opts.apiKey    CONTENT_API_KEY value
 * @returns { published, total }
 */
export async function publishContributors(opts: {
  cacheDir: string
  baseUrl: string
  apiKey: string
}): Promise<{ published: number; total: number }> {
  const { cacheDir, baseUrl, apiKey } = opts
  let files: string[]
  try {
    files = readdirSync(cacheDir).filter((f) => f.endsWith(SUFFIX))
  } catch {
    return { published: 0, total: 0 }
  }

  let published = 0
  for (const f of files) {
    const filePath = join(cacheDir, f)
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    let res: Response
    try {
      res = await fetch(`${baseUrl}/content/publish-contributors`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: raw,
      })
    } catch (err) {
      console.warn(`[publish-contributors] network error for ${f}:`, (err as Error).message)
      continue
    }

    if (res.ok) {
      published += 1
    } else {
      console.warn(`[publish-contributors] ${f} -> ${res.status}`)
    }
  }

  return { published, total: files.length }
}
