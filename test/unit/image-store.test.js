// test/hybrid/image-store.test.js
//
// Round-trip test for srv/lib/image-store.cjs — put → head → getStream.
// Uses in-memory SQLite; no HANA binding required.
//
// Run: npx vitest run --project unit test/unit/image-store.test.js
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
const store = require('../../srv/lib/image-store.cjs')

describe('image-store round-trip', () => {
  const url = 'https://raw.githubusercontent.com/o/r/main/x.png'

  it('put then head then getStream returns the same bytes', async () => {
    const buffer = Buffer.from([137, 80, 78, 71, 1, 2, 3])
    await store.put(url, { buffer, mimeType: 'image/png', contentHash: 'abc', slug: 's', channel: 'prod' })
    const h = await store.head(url)
    expect(h.exists).toBe(true)
    expect(h.contentHash).toBe('abc')
    const got = await store.getStream(url)
    const chunks = []
    for await (const c of got.stream) chunks.push(c)
    expect(Buffer.concat(chunks)).toEqual(buffer)
    expect(got.mimeType).toBe('image/png')
  })

  it('head returns exists:false for an unknown url', async () => {
    expect((await store.head('https://raw.githubusercontent.com/o/r/main/none.png')).exists).toBe(false)
  })
})
