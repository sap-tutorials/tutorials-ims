// test/unit/attachment-ingest-endpoint.test.js
//
// Integration test for POST /content/attachment?u=<encoded-url> (bytes-in ingest).
// Uses in-memory SQLite; no HANA binding required.
//
// Run: npx vitest run --project unit test/unit/attachment-ingest-endpoint.test.js
//
// Boots a full CAP server via cds.test('serve', ..., '--in-memory'). The
// endpoint accepts raw attachment bytes (Content-Type = mime) and writes them
// to attachment-store, authed with CONTENT_API_KEY (same as /content/publish).
//
// NOTE: The route POST /content/attachment is registered in Task 11 (server.js).
// These tests are RED BY DESIGN until Task 11 wires the route.

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { _resetForTests as resetSecretResolver } from '../../srv/lib/secret-resolver.js'

const require = createRequire(import.meta.url)
const store = require('../../srv/lib/attachment-store.cjs')

const project = cds.test('serve', '--project', '.', '--in-memory')

const base = '/content/attachment'

describe('POST /content/attachment (bytes-in ingest)', () => {
  const key = 'test-key'
  const authHeaders = { authorization: `Bearer ${key}`, 'content-type': 'text/plain' }
  // cds.test's axios client re-encodes a Buffer body to {type:'Buffer',data:[...]}
  // JSON shape; identity transformRequest sends raw bytes verbatim.
  const rawCfg = { headers: authHeaders, transformRequest: [(d) => d] }

  beforeAll(() => {
    // contentAuthMiddleware reads CONTENT_API_KEY via secret-resolver (cached
    // in a globalThis singleton). Reset so this worker's value takes effect —
    // matches image-ingest-endpoint.test.js precedent.
    process.env.CONTENT_API_KEY = key
    resetSecretResolver()
  })

  it('stores posted bytes and round-trips via store.getStream', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/push.txt'
    const bytes = Buffer.from('pushed')
    // Native fetch (not axios) so the server's express.raw receives raw bytes.
    const post = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}&slug=s`, {
      method: 'POST', headers: authHeaders, body: bytes,
    })
    expect(post.status).toBe(200)
    const body = await post.json()
    expect(body.action).toBe('stored')

    const got = await store.getStream(url)
    const chunks = []
    for await (const c of got.stream) chunks.push(c)
    expect(Buffer.concat(chunks).toString()).toBe('pushed')
  })

  it('returns unchanged on identical re-post (hash dedup)', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-idem.txt'
    const bytes = Buffer.from('hello dedup')
    const first = await project.post(`${base}?u=${encodeURIComponent(url)}`, bytes, rawCfg)
    expect(first.data.action).toBe('stored')
    const second = await project.post(`${base}?u=${encodeURIComponent(url)}`, bytes, rawCfg)
    expect(second.status).toBe(200)
    expect(second.data.action).toBe('unchanged')
  })

  it('force=1 re-stores identical bytes (bypasses dedup, heals orphans)', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-force.txt'
    const bytes = Buffer.from('force me')
    const first = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}`, {
      method: 'POST', headers: authHeaders, body: bytes,
    })
    expect((await first.json()).action).toBe('stored')
    const forced = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}&force=1`, {
      method: 'POST', headers: authHeaders, body: bytes,
    })
    expect(forced.status).toBe(200)
    expect((await forced.json()).action).toBe('stored')
  })

  it('uses extToMime fallback when content-type is application/octet-stream', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/data.csv'
    const bytes = Buffer.from('a,b\n1,2')
    const post = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}&slug=s`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(post.status).toBe(200)
    expect((await post.json()).action).toBe('stored')
    const got = await store.getStream(url)
    expect(got.mimeType).toBe('text/csv')
  })

  it('rejects an unauthenticated post', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/noauth.txt'
    await expect(
      project.post(`${base}?u=${encodeURIComponent(url)}`, Buffer.from('x'),
        { headers: { 'content-type': 'text/plain' } })
    ).rejects.toMatchObject({ response: { status: 401 } })
  })

  it('400s when the u parameter is missing', async () => {
    await expect(
      project.post(base, Buffer.from('x'), rawCfg)
    ).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('400s on an empty body', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/ingest-empty.txt'
    const res = await fetch(`${project.url}${base}?u=${encodeURIComponent(url)}`, {
      method: 'POST', headers: authHeaders, body: Buffer.alloc(0),
    })
    expect(res.status).toBe(400)
  })
})
