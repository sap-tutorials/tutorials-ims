// test/unit/kg/_search-fetches.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { fetchTutorialsByIds } from '../../../srv/lib/kg/_search-fetches.js'

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
