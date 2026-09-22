import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishValidationRules } from '../../scripts/publish/publish-validation-rules'
import { hashValidationRules } from '../../srv/lib/sidecar-hash.js'

function mockFetch({ remoteHashes = {} } = {}) {
  return vi.fn(async (url) => {
    if (String(url).endsWith('/content/validation-rule-hashes')) {
      return { ok: true, json: async () => remoteHashes }
    }
    return { ok: true, json: async () => ({ ok: true, replaced: 1, notFound: [] }) }
  })
}

describe('publishValidationRules client (#2463 bulk + #2464 hash-skip)', () => {
  let dir
  const demo = { slug: 'demo', rules: [{ stepNumber: 1, questionId: 'validate-1', ruleType: 'single-choice' }] }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vr-'))
    writeFileSync(join(dir, 'demo.validation-rules.json'), JSON.stringify(demo))
  })
  afterEach(() => vi.restoreAllMocks())

  it('bulk-POSTs changed sidecars and fetches the hash feed first', async () => {
    global.fetch = mockFetch({ remoteHashes: {} })
    const res = await publishValidationRules({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    const calls = global.fetch.mock.calls.map((c) => String(c[0]))
    expect(calls).toContain('http://x/content/validation-rule-hashes')
    const bulk = global.fetch.mock.calls.find((c) => String(c[0]).endsWith('-bulk'))
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk[1].body).items[0].slug).toBe('demo')
    expect(res.published).toBe(1)
  })

  it('#2464: skips a sidecar whose hash already matches the server', async () => {
    const matching = hashValidationRules(demo.rules)
    global.fetch = mockFetch({ remoteHashes: { demo: matching } })
    const res = await publishValidationRules({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    const bulk = global.fetch.mock.calls.find((c) => String(c[0]).endsWith('-bulk'))
    expect(bulk).toBeFalsy()
    expect(res.published).toBe(0)
    expect(res.skipped).toBe(1)
  })

  it('#2462: slugs filter with no rules sidecar → zero network calls', async () => {
    global.fetch = mockFetch({ remoteHashes: {} })
    const res = await publishValidationRules({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k', slugs: ['no-rules'] })
    expect(res.total).toBe(0)
    expect(global.fetch.mock.calls.length).toBe(0)
  })
})
