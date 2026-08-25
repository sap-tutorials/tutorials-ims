import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import {
  computeFeedFingerprint,
  readSidecar,
  writeSidecar,
  decideFastPath,
  navEntriesBySlug,
  SIDECAR_VERSION,
  type ContentCacheSidecar,
} from '../../scripts/lib/content-cache'

const FEEDS = { catalog: { missions: [{ id: 1, slugs: ['a', 'b'] }] }, coCompletions: { a: ['b'] }, tagLabels: { cap: 'CAP' } }

describe('computeFeedFingerprint', () => {
  it('is stable regardless of object key order', () => {
    const a = computeFeedFingerprint({ catalog: { x: 1, y: 2 }, coCompletions: {}, tagLabels: {} })
    const b = computeFeedFingerprint({ catalog: { y: 2, x: 1 }, coCompletions: {}, tagLabels: {} })
    expect(a).toBe(b)
  })
  it('changes when the catalog changes', () => {
    const base = computeFeedFingerprint(FEEDS)
    const changed = computeFeedFingerprint({ ...FEEDS, catalog: { missions: [{ id: 1, slugs: ['a', 'b', 'c'] }] } })
    expect(changed).not.toBe(base)
  })
  it('changes when tag-labels change', () => {
    const base = computeFeedFingerprint(FEEDS)
    const changed = computeFeedFingerprint({ ...FEEDS, tagLabels: { cap: 'SAP CAP' } })
    expect(changed).not.toBe(base)
  })
  it('changes when co-completions change', () => {
    const base = computeFeedFingerprint(FEEDS)
    const changed = computeFeedFingerprint({ ...FEEDS, coCompletions: { a: ['b', 'c'] } })
    expect(changed).not.toBe(base)
  })
})

describe('readSidecar / writeSidecar', () => {
  const path = join(tmpdir(), `content-cache-sidecar-test-${process.pid}.json`)
  afterEach(() => { if (existsSync(path)) rmSync(path) })

  it('round-trips a valid sidecar', () => {
    const sidecar: ContentCacheSidecar = { version: SIDECAR_VERSION, feedFingerprint: 'abc', navEntries: [{ slug: 'x' }] }
    writeSidecar(path, sidecar)
    expect(readSidecar(path)).toEqual(sidecar)
  })
  it('returns null when the file is missing', () => {
    expect(readSidecar(join(tmpdir(), 'does-not-exist-xyz.json'))).toBeNull()
  })
  it('returns null on malformed JSON', () => {
    writeFileSync(path, '{not json', 'utf-8')
    expect(readSidecar(path)).toBeNull()
  })
  it('returns null on a version mismatch', () => {
    writeFileSync(path, JSON.stringify({ version: 999, feedFingerprint: 'a', navEntries: [] }), 'utf-8')
    expect(readSidecar(path)).toBeNull()
  })
})

describe('decideFastPath', () => {
  const sidecar: ContentCacheSidecar = { version: SIDECAR_VERSION, feedFingerprint: 'fp', navEntries: [] }
  it('not eligible when the flag is off', () => {
    expect(decideFastPath({ flagEnabled: false, isSlugTargeted: true, sidecar, currentFingerprint: 'fp' }).eligible).toBe(false)
  })
  it('not eligible on a full (non-slug-targeted) run', () => {
    expect(decideFastPath({ flagEnabled: true, isSlugTargeted: false, sidecar, currentFingerprint: 'fp' }).eligible).toBe(false)
  })
  it('not eligible with no sidecar (cache miss)', () => {
    expect(decideFastPath({ flagEnabled: true, isSlugTargeted: true, sidecar: null, currentFingerprint: 'fp' }).eligible).toBe(false)
  })
  it('not eligible when the feed fingerprint changed', () => {
    const d = decideFastPath({ flagEnabled: true, isSlugTargeted: true, sidecar, currentFingerprint: 'DIFFERENT' })
    expect(d.eligible).toBe(false)
    expect(d.reason).toMatch(/fingerprint changed/)
  })
  it('eligible when flag on, slug-targeted, sidecar valid, fingerprint matches', () => {
    expect(decideFastPath({ flagEnabled: true, isSlugTargeted: true, sidecar, currentFingerprint: 'fp' }).eligible).toBe(true)
  })
})

describe('navEntriesBySlug', () => {
  it('maps entries by lowercase slug', () => {
    const map = navEntriesBySlug({ version: SIDECAR_VERSION, feedFingerprint: 'x', navEntries: [{ slug: 'Foo-Bar' }, { slug: 'baz' }] })
    expect(map.get('foo-bar')).toEqual({ slug: 'Foo-Bar' })
    expect(map.get('baz')).toEqual({ slug: 'baz' })
    expect(map.size).toBe(2)
  })
  it('skips entries without a string slug', () => {
    const map = navEntriesBySlug({ version: SIDECAR_VERSION, feedFingerprint: 'x', navEntries: [{ slug: 'ok' }, { notslug: 1 } as never] })
    expect(map.size).toBe(1)
  })
})
