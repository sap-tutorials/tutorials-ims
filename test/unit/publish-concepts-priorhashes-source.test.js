import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'

// #3135 oscillation fix: under Option B (CONTENT_DELTA_READ/skipCarryForward ON),
// ContentFiles is sparse (only freshly-written slugs at a version — carry-forward
// is skipped), while ContentCurrent holds the COMPLETE per-slug set. The concept
// delta-skip's priorHashes must come from ContentCurrent in that mode, else ~all
// concepts look "changed" on alternating runs → full re-render → prod crash.
//
// We mock the delta-flags module so the test controls isDeltaRead() deterministically.
vi.mock('../../srv/lib/content-delta-flags.js', async (orig) => {
  const actual = await orig()
  return { ...actual, isDeltaRead: () => globalThis.__TEST_DELTA_READ__ === true, isDeltaSkipCarryForward: () => globalThis.__TEST_DELTA_READ__ === true }
})

import { loadPriorConceptHashesFor } from '../../srv/lib/publish-concepts.js'

const NS = 'com.sap.developers.ims'

describe('render-concepts priorHashes source under Option B (#3135)', () => {
  beforeAll(async () => {
    await cds.deploy([path.join(process.cwd(), 'db'), path.join(process.cwd(), 'srv')]).to('sqlite::memory:')
    const { ContentManifest, ContentFiles, ContentCurrent } = cds.entities(NS)

    // ACTIVE manifest at version 2 (a "thin" version under skip-carry-forward).
    await INSERT.into(ContentManifest).entries([
      { version: 1, status: 'SUPERSEDED' },
      { version: 2, status: 'ACTIVE' },
    ])
    // ContentFiles @ v2 is SPARSE: only one freshly-written concept this run.
    await INSERT.into(ContentFiles).entries([
      { slug: 'concept-fresh-this-run', version: 2, content: Buffer.from('x'), contentHash: 'HASH_FRESH', mimeType: 'text/html', sizeBytes: 1, compressedBytes: 1 },
    ])
    // ContentCurrent holds the COMPLETE set (fresh + everything carried in prior runs).
    await INSERT.into(ContentCurrent).entries([
      { slug: 'concept-fresh-this-run', content: Buffer.from('x'), contentHash: 'HASH_FRESH', mimeType: 'text/html', sizeBytes: 1, compressedBytes: 1 },
      { slug: 'concept-carried-a', content: Buffer.from('a'), contentHash: 'HASH_A', mimeType: 'text/html', sizeBytes: 1, compressedBytes: 1 },
      { slug: 'concept-carried-b', content: Buffer.from('b'), contentHash: 'HASH_B', mimeType: 'text/html', sizeBytes: 1, compressedBytes: 1 },
      { slug: 'page-not-a-concept', content: Buffer.from('p'), contentHash: 'HASH_P', mimeType: 'text/html', sizeBytes: 1, compressedBytes: 1 },
    ])
  })
  afterAll(async () => { delete globalThis.__TEST_DELTA_READ__; await cds.disconnect() })

  it('reads the COMPLETE concept hash set from ContentCurrent when Option B read is ON', async () => {
    globalThis.__TEST_DELTA_READ__ = true
    const prior = await loadPriorConceptHashesFor({ namespace: NS })
    // All three concept slugs present (not just the one sparse ContentFiles row),
    // and non-concept slugs excluded.
    expect(prior['concept-fresh-this-run']).toBe('HASH_FRESH')
    expect(prior['concept-carried-a']).toBe('HASH_A')
    expect(prior['concept-carried-b']).toBe('HASH_B')
    expect(prior['page-not-a-concept']).toBeUndefined()
  })

  it('reads from ContentFiles@activeVersion when Option B read is OFF (legacy path)', async () => {
    globalThis.__TEST_DELTA_READ__ = false
    const prior = await loadPriorConceptHashesFor({ namespace: NS })
    // Legacy path sees only the sparse v2 ContentFiles row.
    expect(prior['concept-fresh-this-run']).toBe('HASH_FRESH')
    expect(prior['concept-carried-a']).toBeUndefined()
  })
})
