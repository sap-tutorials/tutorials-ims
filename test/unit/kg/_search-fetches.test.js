// test/unit/kg/_search-fetches.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import {
  fetchTutorialsByIds,
  fetchConceptsByIds,
  fetchLinks,
  fetchEdges,
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
