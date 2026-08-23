// test/unit/attachment-store.test.js
//
// Round-trip test for srv/lib/attachment-store.cjs — put → head → getStream.
// Uses in-memory SQLite; no HANA binding required.
//
// Run: npx vitest run --project unit test/unit/attachment-store.test.js
//
// NOTE: runs under the `unit` vitest project. It boots a full CAP server via
// cds.test('serve', '--in-memory') — SQLite only, no `cds bind`/cf-login. It
// lives under test/unit/ (NOT test/hybrid/) on purpose: the `hybrid` project's
// setup binds a live HANA and hangs without cf-login, whereas this test is
// self-contained in-memory.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Boot full CAP server in-memory (SQLite). cds.test registers its own
// beforeAll/afterAll hooks at this scope so all `it()` blocks run after boot.
cds.test('serve', '--project', '.', '--in-memory')

// Loaded after cds.test registers hooks; actual cds.model access happens
// inside function bodies (invoked in it() blocks, post-boot).
const store = require('../../srv/lib/attachment-store.cjs')

describe('attachment-store round-trip', () => {
  const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
  it('put → head → getStream returns the same bytes, mime, and filename', async () => {
    const buffer = Buffer.from('@Search.searchable: true', 'utf8')
    await store.put(url, { buffer, mimeType: 'text/plain; charset=utf-8', contentHash: 'h1', slug: 's', channel: 'prod', filename: 'EX2.txt' })
    const h = await store.head(url)
    expect(h.exists).toBe(true)
    expect(h.contentHash).toBe('h1')
    expect(h.filename).toBe('EX2.txt')
    const got = await store.getStream(url)
    const chunks = []
    for await (const c of got.stream) chunks.push(c)
    expect(Buffer.concat(chunks)).toEqual(buffer)
    expect(got.mimeType).toMatch(/text\/plain/)
    expect(got.filename).toBe('EX2.txt')
  })
  it('head returns exists:false for an unknown url', async () => {
    expect((await store.head('https://raw.githubusercontent.com/o/r/main/none.txt')).exists).toBe(false)
  })
})
