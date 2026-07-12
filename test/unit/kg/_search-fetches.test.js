// test/unit/kg/_search-fetches.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import {
  fetchTutorialsByIds,
  fetchConceptsByIds,
  fetchLinks,
  fetchEdges,
  fetchExternalContentLinks,
} from '../../../srv/lib/kg/_search-fetches.js'

describe('#1113 fetchTutorialsByIds', () => {
  let db
  const ids = ['1113-t1', '1113-t2', '1113-t3-missing']

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    await db.run(INSERT.into('com.sap.developers.ims.Tutorials').entries([
      { ID: ids[0], slug: 't1', title: 'Tutorial One' },
      { ID: ids[1], slug: 't2', title: 'Tutorial Two' },
    ]))
  })

  afterAll(async () => { await db.disconnect?.() })

  it('returns rows for the requested IDs, dropping missing ones', async () => {
    const out = await fetchTutorialsByIds(db, ids)
    expect(out).toHaveLength(2)
    const bySlug = new Map(out.map(r => [r.slug, r]))
    expect(bySlug.get('t1')?.title).toBe('Tutorial One')
    expect(bySlug.get('t2')?.title).toBe('Tutorial Two')
  })

  it('returns empty array for empty input', async () => {
    expect(await fetchTutorialsByIds(db, [])).toEqual([])
    expect(await fetchTutorialsByIds(db, null)).toEqual([])
  })
})

// #1113: HANA folds unquoted aliases to uppercase; assert all four helpers'
// HANA branches emit double-quoted aliases so raw db.run() rows carry the
// lowercase keys that consumers read.
describe('#1113 HANA alias quoting — structural assertions', () => {
  it('fetchTutorialsByIds HANA branch double-quotes all aliases', async () => {
    let sql
    const db = { kind: 'hana', run: async (s) => { sql = s; return [] } }
    await fetchTutorialsByIds(db, ['id-1'])
    expect(sql).toMatch(/as "id"/)
    expect(sql).toMatch(/as "slug"/)
    expect(sql).toMatch(/as "title"/)
  })

  it('fetchConceptsByIds HANA branch double-quotes all aliases', async () => {
    let sql
    const db = { kind: 'hana', run: async (s) => { sql = s; return [] } }
    await fetchConceptsByIds(db, ['id-1'])
    expect(sql).toMatch(/as "id"/)
    expect(sql).toMatch(/as "slug"/)
    expect(sql).toMatch(/as "name"/)
  })

  it('fetchLinks HANA branch double-quotes all aliases', async () => {
    let sql
    const db = { kind: 'hana', run: async (s) => { sql = s; return [] } }
    await fetchLinks(db, ['c1'])
    expect(sql).toMatch(/as "concept_id"/)
    expect(sql).toMatch(/as "tutorial_id"/)
    expect(sql).toMatch(/as "tutorial_slug"/)
    expect(sql).toMatch(/as "title"/)
    expect(sql).toMatch(/as "confidence"/)
  })

  it('fetchEdges HANA branch double-quotes all aliases', async () => {
    let sql
    const db = { kind: 'hana', run: async (s) => { sql = s; return [] } }
    await fetchEdges(db, ['src-1'])
    expect(sql).toMatch(/as "source_id"/)
    expect(sql).toMatch(/as "target_id"/)
    expect(sql).toMatch(/as "predicate"/)
    expect(sql).toMatch(/as "confidence"/)
  })
})

describe('#1125 fetchExternalContentLinks', () => {
  let db
  const cId = 'ec-concept-1'
  const cId2 = 'ec-concept-2'

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
    db = await cds.connect.to('db')
    await cds.deploy(cds.model || 'db/schema.cds').to(db)
    const seen = new Date().toISOString()
    // Concepts (publish-gate columns not required — fetch joins on link tables).
    await db.run(INSERT.into('com.sap.developers.ims.Concepts').entries([
      { ID: cId, slug: 'ai', name: 'AI', status: 'ACTIVE', publishedAt: seen },
      { ID: cId2, slug: 'ml', name: 'ML', status: 'ACTIVE', publishedAt: seen },
    ]))
    // One API doc + link (authoritative), one blog post + link (community).
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocs').entries([
      { ID: 'ad-1', slug: 'ad-cap-node', title: 'CAP Node API', url: 'https://api.sap.com/cap', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.ApiDocConceptLinks').entries([
      { ID: cds.utils.uuid(), apiDoc_ID: 'ad-1', concept_ID: cId, predicate: 'officialReferenceFor', confidence: 0.9 },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPosts').entries([
      { ID: 'bp-1', slug: 'bp-42', title: 'Cool AI post', url: 'https://community.sap.com/bp42', lastSeenAt: seen },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.BlogPostConceptLinks').entries([
      { ID: cds.utils.uuid(), post_ID: 'bp-1', concept_ID: cId, predicate: 'discusses', confidence: 0.6 },
    ]))
    // Community event with endDate (date-aware TTL).
    await db.run(INSERT.into('com.sap.developers.ims.external.CommunityEvents').entries([
      { ID: 'ce-1', slug: 'ce-codejam', title: 'AI CodeJam', url: 'https://events.sap.com/cj', lastSeenAt: seen, startDate: '2026-08-01', endDate: '2026-08-02' },
    ]))
    await db.run(INSERT.into('com.sap.developers.ims.external.CommunityEventConceptLinks').entries([
      { ID: cds.utils.uuid(), event_ID: 'ce-1', concept_ID: cId, predicate: 'covers', confidence: 0.7 },
    ]))
  })
  afterAll(async () => { await db.disconnect?.() })

  it('returns rows across content types for a matched concept, lowercased keys', async () => {
    const rows = await fetchExternalContentLinks(db, [cId])
    const byType = new Map(rows.map(r => [r.content_type, r]))
    expect(byType.get('api-doc')?.slug).toBe('ad-cap-node')
    expect(byType.get('api-doc')?.url).toBe('https://api.sap.com/cap')
    expect(Number(byType.get('api-doc')?.confidence)).toBeCloseTo(0.9)
    expect(byType.get('blog-post')?.title).toBe('Cool AI post')
    expect(byType.get('community-event')?.end_date).toBeTruthy()
    expect(byType.get('community-event')?.concept_id).toBe(cId)
  })

  it('returns empty array for empty / null conceptIds', async () => {
    expect(await fetchExternalContentLinks(db, [])).toEqual([])
    expect(await fetchExternalContentLinks(db, null)).toEqual([])
  })

  it('types filter restricts which content types are returned', async () => {
    const rows = await fetchExternalContentLinks(db, [cId], { types: ['api-doc'] })
    expect(rows.every(r => r.content_type === 'api-doc')).toBe(true)
    expect(rows.length).toBe(1)
  })

  it('returns nothing for a concept with no external links', async () => {
    const rows = await fetchExternalContentLinks(db, [cId2])
    expect(rows).toEqual([])
  })
})

describe('#1125 fetchExternalContentLinks HANA alias quoting', () => {
  it('HANA branch double-quotes all aliases across every UNION arm', async () => {
    let sql
    const db = { kind: 'hana', run: async (s) => { sql = s; return [] } }
    await fetchExternalContentLinks(db, ['c1'])
    expect(sql).toMatch(/as "content_type"/)
    expect(sql).toMatch(/as "concept_id"/)
    expect(sql).toMatch(/as "slug"/)
    expect(sql).toMatch(/as "title"/)
    expect(sql).toMatch(/as "url"/)
    expect(sql).toMatch(/as "confidence"/)
    expect(sql).toMatch(/as "last_seen_at"/)
    expect(sql).toMatch(/as "end_date"/)
    // All 8 content-type literals present.
    for (const t of ['learning-journey','blog-post','discovery-mission','video','api-doc','sample','help-doc','community-event']) {
      expect(sql).toContain(`'${t}'`)
    }
  })
})
