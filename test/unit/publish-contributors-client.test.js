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
})
