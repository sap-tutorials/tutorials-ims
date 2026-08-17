import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ingestImage } = require('../../srv/lib/image-ingest.cjs')

const png = Buffer.from([1,2,3,4])
function okResponse() {
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => png }
}
function fakeStore(initialHash) {
  const state = { hash: initialHash, puts: 0 }
  return { state,
    head: async () => initialHash ? { exists: true, contentHash: initialHash } : { exists: false },
    put: async (_u, { contentHash }) => { state.hash = contentHash; state.puts++ } }
}

describe('ingestImage', () => {
  const RAW = 'raw.githubusercontent.com'
  const base = { slug: 's', channel: 'prod' }
  it('stores when the image is new', async () => {
    const store = fakeStore(null)
    const r = await ingestImage(`https://${RAW}/o/r/main/x.png`, { ...base, deps: {
      fetchImageResponse: async () => okResponse(), safeFetch: {}, resolveSecret: async () => null, store,
    }})
    expect(r.action).toBe('stored'); expect(store.state.puts).toBe(1)
  })
  it('is a no-op when the stored hash already matches (dedup)', async () => {
    const known = require('node:crypto').createHash('sha256').update(png).digest('hex')
    const store = fakeStore(known)
    const r = await ingestImage(`https://${RAW}/o/r/main/x.png`, { ...base, deps: {
      fetchImageResponse: async () => okResponse(), safeFetch: {}, resolveSecret: async () => null, store,
    }})
    expect(r.action).toBe('unchanged'); expect(store.state.puts).toBe(0)
  })
  it('returns failed (no throw) when upstream is not ok', async () => {
    const store = fakeStore(null)
    const r = await ingestImage(`https://${RAW}/o/r/main/x.png`, { ...base, deps: {
      fetchImageResponse: async () => ({ ok: false, status: 429, headers: { get: () => null } }),
      safeFetch: {}, resolveSecret: async () => null, store,
    }})
    expect(r.action).toBe('failed'); expect(r.status).toBe(429); expect(store.state.puts).toBe(0)
  })
})
