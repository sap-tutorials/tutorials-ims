// test/unit/image-ingest-endpoint.test.js
//
// Integration test for POST /content/image?u=<encoded-url> (bytes-in ingest).
// Uses in-memory SQLite; no HANA binding required.
//
// Run: npx vitest run --project unit test/unit/image-ingest-endpoint.test.js
//
// Boots a full CAP server via cds.test('serve', ..., '--in-memory'). The
// endpoint accepts raw image bytes (Content-Type = mime) and writes them to
// image-store, authed with CONTENT_API_KEY (same as /content/publish).

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { _resetForTests as resetSecretResolver } from '../../srv/lib/secret-resolver.js'

const project = cds.test('serve', '--project', '.', '--in-memory')

const base = '/content/image'
const src = '/content/image-source'

describe('POST /content/image (bytes-in ingest)', () => {
  const key = 'test-key'
  const authHeaders = { authorization: `Bearer ${key}`, 'content-type': 'image/png' }
  // cds.test's axios client otherwise re-encodes a Buffer body (e.g. to the
  // {type:'Buffer',data:[...]} JSON shape); identity transformRequest sends the
  // raw bytes so the server's express.raw receives them verbatim.
  const rawCfg = { headers: authHeaders, transformRequest: [(d) => d] }

  beforeAll(() => {
    // contentAuthMiddleware reads CONTENT_API_KEY via secret-resolver (cached
    // in a globalThis singleton). Reset so this worker's value takes effect —
    // matches orphan-purge-endpoint.test.js precedent.
    process.env.CONTENT_API_KEY = key
    resetSecretResolver()
  })

  it('stores posted bytes and serves them back from the store', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-hit.png'
    const bytes = Buffer.from([1, 2, 3, 4, 5])
    // Native fetch (not the cds.test axios client, which JSON-serializes a
    // Buffer body to {type:'Buffer',data:[...]}) so the server receives the
    // raw bytes verbatim.
    const post = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}&slug=demo`, {
      method: 'POST', headers: authHeaders, body: bytes,
    })
    expect(post.status).toBe(200)
    expect((await post.json()).action).toBe('stored')

    const got = await project.get(`${src}?u=${encodeURIComponent(url)}`, { responseType: 'arraybuffer' })
    expect(got.status).toBe(200)
    expect(got.headers['content-type']).toMatch(/image\/png/)
    expect(Buffer.from(got.data)).toEqual(bytes)
  })

  it('returns unchanged on identical re-post (hash dedup)', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-idem.png'
    const bytes = Buffer.from([7, 7, 7])
    const first = await project.post(`${base}?u=${encodeURIComponent(url)}`, bytes, rawCfg)
    expect(first.data.action).toBe('stored')
    const second = await project.post(`${base}?u=${encodeURIComponent(url)}`, bytes, rawCfg)
    expect(second.status).toBe(200)
    expect(second.data.action).toBe('unchanged')
  })

  it('force=1 re-stores identical bytes (bypasses dedup, heals orphans)', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-force.png'
    const bytes = Buffer.from([5, 5, 5])
    // Native fetch to send raw bytes (axios re-encodes a Buffer body).
    const first = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}`, { method: 'POST', headers: authHeaders, body: bytes })
    expect((await first.json()).action).toBe('stored')
    // Without force this would be 'unchanged'; with force it re-stores.
    const forced = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}&force=1`, { method: 'POST', headers: authHeaders, body: bytes })
    expect(forced.status).toBe(200)
    expect((await forced.json()).action).toBe('stored')
  })

  it('rejects an unauthenticated post', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-noauth.png'
    await expect(
      project.post(`${base}?u=${encodeURIComponent(url)}`, Buffer.from([1]), { headers: { 'content-type': 'image/png' } })
    ).rejects.toMatchObject({ response: { status: 401 } })
  })

  it('400s when the u parameter is missing', async () => {
    await expect(
      project.post(base, Buffer.from([1]), rawCfg)
    ).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('400s on an empty body', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-empty.png'
    // Native fetch to send a genuinely empty body (axios would serialize the
    // empty Buffer to a non-empty JSON string).
    const res = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}`, {
      method: 'POST', headers: authHeaders, body: Buffer.alloc(0),
    })
    expect(res.status).toBe(400)
  })
})
