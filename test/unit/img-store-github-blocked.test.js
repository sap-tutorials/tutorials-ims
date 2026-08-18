// test/unit/img-store-github-blocked.test.js
//
// Outage-resilience proof: images pre-warmed in the store are served even when
// GitHub is completely unreachable.
//
// Two assertions:
//   (a) OUTAGE-SURVIVES — A URL whose bytes were previously put() into the store
//       returns 200 + exact bytes.  The store-hit path in imageSourceHandler
//       calls getStream() directly and NEVER touches GitHub/safeFetch, so this
//       succeeds even if raw.githubusercontent.com is down.
//   (b) COLD-MISS-FAILS-FAST — A URL that was never stored AND whose host is NOT
//       on the IMG_CDN_HOSTS allowlist hits safeFetch, which throws SSRF_BLOCKED
//       synchronously (no network call).  imageSourceHandler catches the throw
//       and returns 404.  No hang, no timeout wait.
//
// "GitHub unreachable" is simulated for the cold-miss case by using a host that
// is not on the allowlist (not-on-allowlist.invalid).  safeFetch rejects it
// before making any network connection, so the test is deterministic and fast.
//
// Run: npx vitest run --project unit test/unit/img-store-github-blocked.test.js
//
// Lives under test/unit/ (NOT test/hybrid/) — uses in-memory SQLite only,
// no cds bind or cf login required.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Boot full CAP server in-memory (SQLite). cds.test registers beforeAll/afterAll
// hooks at this scope so all it() blocks run after boot.
const project = cds.test('serve', '--project', '.', '--in-memory')

// Loaded after cds.test registers hooks; actual cds.model access happens
// inside it() bodies (post-boot).
const store = require('../../srv/lib/image-store.cjs')

const base = '/content/image-source'

describe('image-store outage resilience — GitHub blocked', () => {
  it(
    '(a) OUTAGE-SURVIVES: serves pre-warmed image bytes without any GitHub round-trip',
    async () => {
      const url = 'https://raw.githubusercontent.com/sap-tutorials/test/main/img-blocked-test.png'
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes

      // Pre-warm the store (simulates what ingestImage does at publish time)
      await store.put(url, {
        buffer: bytes,
        mimeType: 'image/png',
        contentHash: 'blocked-test-hash',
        slug: 'test-tutorial',
        channel: 'prod',
      })

      // Even if GitHub is down, the store-hit path streams directly from HANA/SQLite.
      const res = await project.get(`${base}?u=${encodeURIComponent(url)}`, {
        responseType: 'arraybuffer',
      })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/image\/png/)
      expect(Buffer.from(res.data)).toEqual(bytes)
    },
    15_000
  )

  it(
    '(b) COLD-MISS-FAILS-FAST: 404 immediately for an unwarmed URL on a blocked host',
    async () => {
      // Host is NOT on IMG_CDN_HOSTS (raw.githubusercontent.com is the only
      // allowed host). safeFetch throws SSRF_BLOCKED synchronously — no network
      // connection is made, so the test is deterministic and finishes fast even
      // if every external host is unreachable.
      const url = 'https://not-on-allowlist.invalid/github-blocked-cold.png'

      await expect(
        project.get(`${base}?u=${encodeURIComponent(url)}`)
      ).rejects.toMatchObject({ response: { status: 404 } })
    },
    10_000
  )
})
