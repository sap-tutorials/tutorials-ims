// test/unit/attachment-source-endpoint.test.js
//
// Integration test for GET /content/attachment-source?u=<encoded-url>&dl=.
// Uses in-memory SQLite; no HANA binding required.
//
// Run: npx vitest run --project unit test/unit/attachment-source-endpoint.test.js
//
// NOTE: runs under the `unit` vitest project. It boots a full CAP server via
// cds.test('serve', '--project', '.', '--in-memory') — SQLite only, no cds bind/cf login.
//
// RED-BY-DESIGN until Task 11: the route GET /content/attachment-source is
// registered in srv/server.js at Task 11. All cases here will 404 at the
// router level (no matching route) until then. Do NOT register the route here.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Boot full CAP server in-memory (SQLite). cds.test registers its own
// beforeAll/afterAll hooks at this scope so all `it()` blocks run after boot.
const project = cds.test('serve', '--project', '.', '--in-memory')

// Loaded after cds.test registers hooks; actual store access happens inside
// function bodies (invoked in it() blocks, post-boot).
const store = require('../../srv/lib/attachment-store.cjs')

const base = '/content/attachment-source'

describe('GET /content/attachment-source', () => {
  it('streams a stored .txt inline', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
    await store.put(url, {
      buffer: Buffer.from('code'),
      mimeType: 'text/plain; charset=utf-8',
      contentHash: 'h',
      slug: 's',
      channel: 'prod',
      filename: 'EX2.txt',
    })
    const res = await project.get(`${base}?u=${encodeURIComponent(url)}`, {
      responseType: 'arraybuffer',
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.headers['content-disposition']).toMatch(/^inline/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('dl=1 forces attachment disposition', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/D2.txt'
    await store.put(url, {
      buffer: Buffer.from('x'),
      mimeType: 'text/plain; charset=utf-8',
      contentHash: 'h2',
      slug: 's',
      channel: 'prod',
      filename: 'D2.txt',
    })
    const res = await project.get(`${base}?u=${encodeURIComponent(url)}&dl=1`, {
      responseType: 'arraybuffer',
    })
    expect(res.headers['content-disposition']).toMatch(/^attachment/)
  })

  it('400 on missing u', async () => {
    await expect(project.get(base)).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('404 on a miss that cannot self-heal (disallowed host)', async () => {
    // Use a host NOT in ATTACHMENT_HOSTS (raw.githubusercontent.com).
    // fetchImageResponse / safeFetch will throw SSRF_BLOCKED synchronously
    // (no network call) because example.invalid is not on the allowed-hosts set.
    // attachmentSourceHandler catches the throw and returns 404.
    const url = 'https://example.invalid/missing.txt'
    await expect(
      project.get(`${base}?u=${encodeURIComponent(url)}`)
    ).rejects.toMatchObject({ response: { status: 404 } })
  })
})
