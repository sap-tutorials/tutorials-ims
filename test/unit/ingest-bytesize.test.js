// test/unit/ingest-bytesize.test.js
//
// Verifies that byteSize = buffer.length is persisted on the parent row when
// image-store.cjs / attachment-store.cjs put() is called with a byteSize option.
//
// Run: npx vitest run --project unit test/unit/ingest-bytesize.test.js
//
// Boot full CAP server in-memory (SQLite). cds.test registers its own
// beforeAll/afterAll hooks at this scope so all it() blocks run after boot.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

cds.test('serve', '--project', '.', '--in-memory')

const imageStore = require('../../srv/lib/image-store.cjs')
const attachmentStore = require('../../srv/lib/attachment-store.cjs')

describe('image store persists byteSize', () => {
  it('stores buffer.length as byteSize on the TutorialImages row', async () => {
    const buf = Buffer.from('hello world')
    await imageStore.put('https://raw.example/img.png', {
      buffer: buf, mimeType: 'image/png', contentHash: 'abc123',
      slug: 'demo', channel: 'prod', byteSize: buf.length,
    })
    const { TutorialImages } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(TutorialImages).where({ sourceUrl: 'https://raw.example/img.png' })
    expect(Number(row.byteSize)).toBe(11)
  })
})

describe('attachment store persists byteSize', () => {
  it('stores buffer.length as byteSize on the TutorialAssets row', async () => {
    const buf = Buffer.from('hello world')
    await attachmentStore.put('https://raw.example/file.txt', {
      buffer: buf, mimeType: 'text/plain', contentHash: 'def456',
      slug: 'demo', channel: 'prod', filename: 'file.txt', byteSize: buf.length,
    })
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(TutorialAssets).where({ sourceUrl: 'https://raw.example/file.txt' })
    expect(Number(row.byteSize)).toBe(11)
  })
})
