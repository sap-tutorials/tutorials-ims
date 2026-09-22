import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishContributors } from '../../scripts/publish/publish-contributors'

describe('publishContributors client', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-'))
    writeFileSync(join(dir, 'demo.contributors.json'),
      JSON.stringify({ slug: 'demo', contributors: [{ login: 'octocat', name: 'O', email: 'o@x', avatarUrl: 'a' }] }))
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, count: 1 }) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('POSTs each sidecar to the endpoint', async () => {
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('http://x/content/publish-contributors')
    expect(JSON.parse(opts.body).slug).toBe('demo')
    expect(res.published).toBe(1)
  })

  it('#2462: slugs filter only POSTs sidecars for changed slugs present in cache', async () => {
    // cache has demo + other; publish only "demo"
    writeFileSync(join(dir, 'other.contributors.json'),
      JSON.stringify({ slug: 'other', contributors: [] }))
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k', slugs: ['demo'] })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).slug).toBe('demo')
    expect(res.total).toBe(1)
  })

  it('#2462: slugs filter skips changed slugs that have no sidecar (zero POSTs)', async () => {
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k', slugs: ['no-such-slug'] })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(res.published).toBe(0)
    expect(res.total).toBe(0)
  })
})
