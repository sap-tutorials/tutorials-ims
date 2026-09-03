import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'; import { tmpdir } from 'node:os'
import { publishValidationRules } from '../../scripts/publish/publish-validation-rules'

describe('publishValidationRules client', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vr-'))
    writeFileSync(join(dir, 'demo.validation-rules.json'),
      JSON.stringify({ slug: 'demo', rules: [{ stepNumber: 1, questionId: 'validate-1' }] }))
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  })
  afterEach(() => vi.restoreAllMocks())
  it('POSTs each sidecar', async () => {
    const res = await publishValidationRules({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe('http://x/content/publish-validation-rules')
    expect(res.published).toBe(1)
  })
})
