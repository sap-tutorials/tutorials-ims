// test/unit/image-source-endpoint.test.js
//
// Integration test for GET /content/image-source?u=<encoded-url>.
// Uses in-memory SQLite; no HANA binding required.
//
// Run: npx vitest run --project unit test/unit/image-source-endpoint.test.js
//
// NOTE: runs under the `unit` vitest project. It boots a full CAP server via
// cds.test('serve', '--project', '.', '--in-memory') — SQLite only, no cds bind/cf login.
// Lives under test/unit/ (NOT test/hybrid/) for the same reason as image-store.test.js.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Boot full CAP server in-memory (SQLite). cds.test registers its own
// beforeAll/afterAll hooks at this scope so all `it()` blocks run after boot.
const project = cds.test('serve', '--project', '.', '--in-memory')

// Loaded after cds.test registers hooks; actual cds.model access happens
// inside function bodies (invoked in it() blocks, post-boot).
const store = require('../../srv/lib/image-store.cjs')

const base = '/content/image-source'

describe('GET /content/image-source', () => {
  it('streams a stored image (store hit)', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/hit.png'
    await store.put(url, {
      buffer: Buffer.from([9, 9, 9]),
      mimeType: 'image/png',
      contentHash: 'h1',
      slug: 's',
      channel: 'prod',
    })
    const res = await project.get(`${base}?u=${encodeURIComponent(url)}`, {
      responseType: 'arraybuffer',
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(Buffer.from(res.data)).toEqual(Buffer.from([9, 9, 9]))
  })

  it('404s when the image is absent and self-heal ingest fails', async () => {
    // Use a URL with a host NOT in IMG_CDN_HOSTS (raw.githubusercontent.com).
    // safeFetch will throw SSRF_BLOCKED synchronously (no network call) because
    // the host is not on the allowed-hosts set. imageSourceHandler catches the
    // throw and returns 404.
    const url = 'https://not-on-allowlist.invalid/missing.png'
    await expect(
      project.get(`${base}?u=${encodeURIComponent(url)}`)
    ).rejects.toMatchObject({ response: { status: 404 } })
  })
})
