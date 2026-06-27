import cds from '@sap/cds'
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { isSafeForWrites } from './_guard.js'

const allowWrites = isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(allowWrites)('publishConcept / unpublishConcept admin actions', () => {
  let db, kg
  const TEST_PREFIX = '__TEST__phase3-publish-'
  const testIds = []

  beforeAll(async () => {
    await cds.connect.to('db')
    db = cds.db
    kg = await cds.connect.to('KnowledgeGraphService')
  })

  afterAll(async () => {
    if (testIds.length) {
      await DELETE.from('com.sap.developers.ims.Concepts').where({ ID: { in: testIds } })
    }
    // Belt-and-braces: clean any rows whose slug starts with our prefix in case
    // a test died mid-INSERT before the ID was pushed to testIds. Without this,
    // @assert.unique.slug on Concepts blocks reruns.
    await DELETE.from('com.sap.developers.ims.Concepts').where({ slug: { like: TEST_PREFIX + '%' } })
  })

  it('publishConcept sets publishedAt + publishedBy; unpublishConcept clears both', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const inserted = await INSERT.into(Concepts).entries({
      slug: TEST_PREFIX + 'a',
      name: 'Publish Test A',
      status: 'ACTIVE',
    })
    // INSERT.entries() may return `[{...}]` or `{results: [{...}]}` on HANA
    // depending on driver version. Fall back to a SELECT on the unique slug.
    let ID
    if (Array.isArray(inserted) && inserted[0]?.ID) ID = inserted[0].ID
    else if (inserted?.results?.[0]?.ID) ID = inserted.results[0].ID
    else {
      const row = await SELECT.one.from(Concepts).columns('ID').where({ slug: TEST_PREFIX + 'a' })
      ID = row.ID
    }
    testIds.push(ID)

    let row = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID })
    expect(row.publishedAt).toBeNull()
    expect(row.publishedBy).toBeNull()

    await kg.send('publishConcept', ID, {})
    row = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID })
    expect(row.publishedAt).toBeTruthy()
    expect(row.publishedBy).toBeTruthy()

    await kg.send('unpublishConcept', ID, {})
    row = await SELECT.one.from(Concepts).columns('publishedAt', 'publishedBy').where({ ID })
    expect(row.publishedAt).toBeNull()
    expect(row.publishedBy).toBeNull()
  })

  it('PublishedConcepts view returns published+active only', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const fixtures = [
      { slug: TEST_PREFIX + 'never', name: 'never', status: 'ACTIVE' },
      { slug: TEST_PREFIX + 'pub',   name: 'pub',   status: 'ACTIVE' },
      { slug: TEST_PREFIX + 'unpub', name: 'unpub', status: 'ACTIVE' },
      { slug: TEST_PREFIX + 'veto',  name: 'veto',  status: 'VETOED' },
    ]
    const inserted = await INSERT.into(Concepts).entries(fixtures)
    const ids = Array.isArray(inserted)
      ? inserted.map(r => r.ID)
      : inserted.results.map(r => r.ID)
    // Some drivers don't return IDs on bulk insert — fall back to SELECT.
    let resolvedIds = ids.filter(Boolean)
    if (resolvedIds.length < fixtures.length) {
      const rows = await SELECT.from(Concepts)
        .columns('ID', 'slug')
        .where({ slug: { in: fixtures.map(f => f.slug) } })
      const bySlug = new Map(rows.map(r => [r.slug, r.ID]))
      resolvedIds = fixtures.map(f => bySlug.get(f.slug))
    }
    testIds.push(...resolvedIds)

    // Publish the last three; then unpublish the unpub one; veto stays as VETOED.
    await kg.send('publishConcept', resolvedIds[1], {})
    await kg.send('publishConcept', resolvedIds[2], {})
    await kg.send('publishConcept', resolvedIds[3], {})
    await kg.send('unpublishConcept', resolvedIds[2], {})

    const visible = await kg.read('PublishedConcepts')
      .where({ slug: { like: TEST_PREFIX + '%' } })

    const visibleSlugs = visible.map(r => r.slug)
    expect(visibleSlugs).toEqual([TEST_PREFIX + 'pub'])
  })
})
