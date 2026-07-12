// test/unit/kg/external-content-signal.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import cds from '@sap/cds'
import { computeExternalContentSignal } from '../../../srv/lib/kg/external-content-signal.js'
import { _resetForTest } from '../../../srv/lib/search-kg-signal.js'

function encode(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}
function unit(i, dims = 1536) { const v = new Array(dims).fill(0); v[i] = 1; return v }

describe('#1125 computeExternalContentSignal', () => {
  let db
  const cId = 'ecs-ai'
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const seen = new Date().toISOString()
    const active = { status: 'ACTIVE', publishedAt: seen, mergedInto_ID: null }
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: cId, slug: 'ai', name: 'AI', embedding: encode(unit(0)), ...active },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocs').entries([
      { ID: 'ad-1', slug: 'ad-cap', title: 'CAP API', url: 'https://api.sap.com/cap', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocConceptLinks').entries([
      { ID: cds.utils.uuid(), apiDoc_ID: 'ad-1', concept_ID: cId, predicate: 'officialReferenceFor', confidence: 0.9 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPosts').entries([
      { ID: 'bp-1', slug: 'bp-1', title: 'AI blog', url: 'https://community.sap.com/1', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPostConceptLinks').entries([
      { ID: cds.utils.uuid(), post_ID: 'bp-1', concept_ID: cId, predicate: 'discusses', confidence: 0.5 },
    ]))
    // A stale api-doc (lastSeenAt far in the past) — should be TTL-dropped (api-doc TTL 1095 days).
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocs').entries([
      { ID: 'ad-stale', slug: 'ad-old', title: 'Old API', url: 'https://api.sap.com/old', lastSeenAt: '2015-01-01T00:00:00Z' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocConceptLinks').entries([
      { ID: cds.utils.uuid(), apiDoc_ID: 'ad-stale', concept_ID: cId, predicate: 'officialReferenceFor', confidence: 0.9 },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })
  beforeEach(() => _resetForTest())

  it('returns ranked external content with trust tiers', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    const bySlug = new Map(out.externalContent.map(e => [e.slug, e]))
    expect(bySlug.get('ad-cap')?.trustTier).toBe('authoritative')
    expect(bySlug.get('ad-cap')?.type).toBe('api-doc')
    expect(bySlug.get('bp-1')?.trustTier).toBe('community')
    // score = conceptScore(=1 for exact cosine) * confidence
    expect(bySlug.get('ad-cap')?.score).toBeGreaterThan(bySlug.get('bp-1')?.score)
    expect(bySlug.get('ad-cap')?.rationale).toMatch(/AI/)
  })

  it('drops TTL-expired rows (stale api-doc absent)', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    expect(out.externalContent.some(e => e.slug === 'ad-old')).toBe(false)
  })

  it('honors maxItems cap', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient, maxItems: 1 })
    expect(out.externalContent.length).toBe(1)
  })

  it('honors types filter', async () => {
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'ai', db, embedClient, types: ['api-doc'] })
    expect(out.externalContent.every(e => e.type === 'api-doc')).toBe(true)
  })

  it('reuses the shared cache — one embed across two calls', async () => {
    const embed = vi.fn(async () => Float32Array.from(unit(0)))
    const embedClient = { embed }
    await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    await computeExternalContentSignal({ phrase: 'ai', db, embedClient })
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('propagates kg_empty warning with empty content', async () => {
    const empty = await cds.connect.to({ kind: 'sqlite', credentials: { url: ':memory:' } })
    await cds.deploy(cds.model || 'db/schema.cds').to(empty)
    const embedClient = { embed: async () => Float32Array.from(unit(0)) }
    const out = await computeExternalContentSignal({ phrase: 'x', db: empty, embedClient })
    expect(out.warning).toBe('kg_empty')
    expect(out.externalContent).toEqual([])
  })

  it('empty phrase returns empty without embedding', async () => {
    const embed = vi.fn()
    const out = await computeExternalContentSignal({ phrase: '  ', db, embedClient: { embed } })
    expect(out.externalContent).toEqual([])
    expect(embed).not.toHaveBeenCalled()
  })
})
