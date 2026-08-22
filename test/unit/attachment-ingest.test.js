import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ingestAttachment } = require('../../srv/lib/attachment-ingest.cjs')

function res(body, { ok = true, status = 200, ct = 'text/plain' } = {}) {
  return { ok, status, headers: new Map([['content-type', ct], ['content-length', String(body.length)]]),
    arrayBuffer: async () => Buffer.from(body) }
}

describe('ingestAttachment', () => {
  const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
  it('stores on a fresh URL', async () => {
    const store = { head: vi.fn().mockResolvedValue({ exists: false }), put: vi.fn().mockResolvedValue() }
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('hello')), safeFetch: {}, resolveSecret: {}, store }
    const out = await ingestAttachment(url, { slug: 's', channel: 'prod', deps })
    expect(out.action).toBe('stored')
    expect(store.put).toHaveBeenCalledOnce()
  })
  it('is unchanged when hash matches', async () => {
    const buf = Buffer.from('hello')
    const crypto = require('node:crypto')
    const h = crypto.createHash('sha256').update(buf).digest('hex')
    const store = { head: vi.fn().mockResolvedValue({ exists: true, contentHash: h }), put: vi.fn() }
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('hello')), store }
    const out = await ingestAttachment(url, { slug: 's', channel: 'prod', deps })
    expect(out.action).toBe('unchanged')
    expect(store.put).not.toHaveBeenCalled()
  })
  it('fails on a non-ok fetch', async () => {
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('', { ok: false, status: 404 })), store: {} }
    const out = await ingestAttachment(url, { slug: 's', channel: 'prod', deps })
    expect(out).toEqual({ action: 'failed', status: 404 })
  })
  it('uses extToMime when the response content-type is generic', async () => {
    const store = { head: vi.fn().mockResolvedValue({ exists: false }), put: vi.fn().mockResolvedValue() }
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('{}', { ct: 'application/octet-stream' })), store }
    await ingestAttachment('https://raw.githubusercontent.com/o/r/main/a.json', { slug: 's', channel: 'prod', deps })
    expect(store.put.mock.calls[0][1].mimeType).toBe('application/json')
  })
})
