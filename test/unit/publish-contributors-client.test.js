import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishContributors } from '../../scripts/publish/publish-contributors'
import { hashContributors } from '../../srv/lib/sidecar-hash.js'

// The client now: GET /content/contributor-hashes (delta-skip #2464), then
// POST /content/publish-contributors-bulk with { items } (#2463).
function mockFetch({ remoteHashes = {} } = {}) {
  return vi.fn(async (url) => {
    if (String(url).endsWith('/content/contributor-hashes')) {
      return { ok: true, json: async () => remoteHashes }
    }
    // bulk POST
    return { ok: true, json: async () => ({ ok: true, replaced: 1, notFound: [] }) }
  })
}

describe('publishContributors client (#2463 bulk + #2464 hash-skip)', () => {
  let dir
  const demo = { slug: 'demo', contributors: [{ login: 'octocat', name: 'O', email: 'o@x', avatarUrl: 'a' }] }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-'))
    writeFileSync(join(dir, 'demo.contributors.json'), JSON.stringify(demo))
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('bulk-POSTs changed sidecars and fetches the hash feed first', async () => {
    global.fetch = mockFetch({ remoteHashes: {} }) // server has nothing → demo is changed
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    const calls = global.fetch.mock.calls.map((c) => String(c[0]))
    expect(calls).toContain('http://x/content/contributor-hashes')
    const bulk = global.fetch.mock.calls.find((c) => String(c[0]).endsWith('-bulk'))
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk[1].body).items[0].slug).toBe('demo')
    expect(res.published).toBe(1)
    expect(res.skipped).toBe(0)
  })

  it('#2464: skips a sidecar whose hash already matches the server', async () => {
    const matching = hashContributors(demo.contributors)
    global.fetch = mockFetch({ remoteHashes: { demo: matching } })
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    const bulk = global.fetch.mock.calls.find((c) => String(c[0]).endsWith('-bulk'))
    expect(bulk).toBeFalsy() // nothing changed → no bulk POST
    expect(res.published).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.total).toBe(1)
  })

  it('#2462: slugs filter narrows candidates before hashing', async () => {
    writeFileSync(join(dir, 'other.contributors.json'), JSON.stringify({ slug: 'other', contributors: [] }))
    global.fetch = mockFetch({ remoteHashes: {} })
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k', slugs: ['demo'] })
    const bulk = global.fetch.mock.calls.find((c) => String(c[0]).endsWith('-bulk'))
    expect(JSON.parse(bulk[1].body).items.map((i) => i.slug)).toEqual(['demo'])
    expect(res.total).toBe(1)
  })

  it('slugs filter with no matching sidecar → zero fetches for bulk', async () => {
    global.fetch = mockFetch({ remoteHashes: {} })
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k', slugs: ['no-such'] })
    expect(res.published).toBe(0)
    expect(res.total).toBe(0)
    // no candidates → returns before touching the network at all
    expect(global.fetch.mock.calls.length).toBe(0)
  })
})
