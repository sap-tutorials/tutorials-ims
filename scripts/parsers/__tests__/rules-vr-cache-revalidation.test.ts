import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRulesVr } from '../github.js'

// CACHE_DIR in github.ts is <repo>/.tutorial-cache. This test file lives at
// scripts/parsers/__tests__/, so ../../../.tutorial-cache resolves to the same dir.
const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '..', '..', '..', '.tutorial-cache')

// Unique per-run slug so we never collide with real cached tutorials.
const SLUG = '__test-rulesvr-revalidation__'
const cacheFile = join(CACHE_DIR, `${SLUG}.rules.vr`)
const etagFile = join(CACHE_DIR, `${SLUG}.rules.vr.etag`)

function cleanup() {
  for (const f of [cacheFile, etagFile]) if (existsSync(f)) rmSync(f)
}

function res(status: number, body = '', etag?: string): Response {
  const headers = new Headers()
  if (etag) headers.set('etag', etag)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => body,
  } as unknown as Response
}

const PLACEHOLDER = '[VALIDATE_1]\n###Rule\nexact-match\n###Match\n81ljashljf\n[VALIDATE_1]\n'
const REAL = '[VALIDATE_1]\n###Rule\nexact-match\n###Match\n30\n[VALIDATE_1]\n'

describe('fetchRulesVr — cache revalidation (#1940)', () => {
  const origToken = process.env.GITHUB_TOKEN
  const origContribToken = process.env.TUTORIALS_GITHUB_TOKEN

  beforeEach(() => {
    cleanup()
    mkdirSync(CACHE_DIR, { recursive: true })
    process.env.GITHUB_TOKEN = 'test-token'
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    if (origToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = origToken
    if (origContribToken === undefined) delete process.env.TUTORIALS_GITHUB_TOKEN
    else process.env.TUTORIALS_GITHUB_TOKEN = origContribToken
  })

  it('picks up an edited answer even when a stale rules.vr is already cached (the bug)', async () => {
    const fetchMock = vi.fn()
      // First call: source has the placeholder answer.
      .mockResolvedValueOnce(res(200, PLACEHOLDER, '"etag-placeholder"'))
      // Second call: author has edited the answer to 30 → new ETag, 200.
      .mockResolvedValueOnce(res(200, REAL, '"etag-real"'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    expect(first).toBe(PLACEHOLDER)

    const second = await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    // Pre-fix, this returned the cached PLACEHOLDER forever. Now it reflects the edit.
    expect(second).toBe(REAL)
  })

  it('sends If-None-Match and reuses cache on 304 (unchanged source)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(200, REAL, '"etag-real"'))
      .mockResolvedValueOnce(res(304))
    vi.stubGlobal('fetch', fetchMock)

    await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    const second = await fetchRulesVr(SLUG, 'developer-advocates', 'main')

    expect(second).toBe(REAL)
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(secondHeaders['If-None-Match']).toBe('"etag-real"')
  })

  it('fetches from the -Contribution repo', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, REAL, '"e"'))
    vi.stubGlobal('fetch', fetchMock)
    await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    expect(fetchMock.mock.calls[0][0]).toContain('developer-advocates-Contribution')
  })

  it('returns null when rules.vr is removed at source (404), not stale cache', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(200, REAL, '"etag-real"'))
      .mockResolvedValueOnce(res(404))
    vi.stubGlobal('fetch', fetchMock)

    await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    const gone = await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    expect(gone).toBeNull()
  })

  it('falls back to cached copy on a transient error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(200, REAL, '"etag-real"'))
      .mockResolvedValueOnce(res(500))
    vi.stubGlobal('fetch', fetchMock)

    await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    const resilient = await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    expect(resilient).toBe(REAL)
  })

  it('re-fetches unconditionally when a cache exists without an ETag sidecar (heals legacy cache)', async () => {
    // Simulate a pre-fix cache: content present, no .etag sidecar.
    writeFileSync(cacheFile, PLACEHOLDER, 'utf-8')
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, REAL, '"etag-real"'))
    vi.stubGlobal('fetch', fetchMock)

    const out = await fetchRulesVr(SLUG, 'developer-advocates', 'main')
    expect(out).toBe(REAL)
    // No conditional header on the heal fetch.
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['If-None-Match']).toBeUndefined()
  })
})
