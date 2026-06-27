import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js'

describe('buildConceptsPayload', () => {
  beforeAll(async () => {
    const schemaRoots = [
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]
    await cds.deploy(schemaRoots).to('sqlite::memory:')
    const { Concepts, ConceptEdges, TutorialConceptLinks, Tutorials } =
      cds.entities('com.sap.developers.ims')

    await INSERT.into(Concepts).entries([
      { slug: 'cap-handlers', name: 'CAP handlers', description: 'desc 1',
        status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
      { slug: 'cap-services', name: 'CAP services', description: 'desc 2',
        status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
      { slug: 'never', name: 'never', status: 'ACTIVE' },
      { slug: 'vetoed-but-published', name: 'Vetoed', description: 'should be excluded',
        status: 'VETOED', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
    ])

    await INSERT.into(Tutorials).entries({
      slug: 't1', title: 'Tutorial One', status: 'ACTIVE'
    })

    const conceptRows = await SELECT.from(Concepts).columns('ID', 'slug')
      .where({ slug: { in: ['cap-handlers', 'cap-services'] } })
    const handlersId  = conceptRows.find(c => c.slug === 'cap-handlers').ID
    const servicesId  = conceptRows.find(c => c.slug === 'cap-services').ID
    const tutRow = await SELECT.one.from(Tutorials).columns('ID').where({ slug: 't1' })

    await INSERT.into(TutorialConceptLinks).entries({
      tutorial_ID: tutRow.ID, concept_ID: handlersId, predicate: 'teaches',
    })

    await INSERT.into(ConceptEdges).entries({
      source_ID: handlersId, target_ID: servicesId, predicate: 'requires',
      status: 'ACTIVE',
    })
  })

  afterAll(async () => {
    await cds.disconnect()
  })

  it('returns only published concepts', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const slugs = payload.concepts.map(c => c.slug).sort()
    expect(slugs).toEqual(['cap-handlers', 'cap-services'])
  })

  it('populates teaches[] with tutorials teaching the concept', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers')
    expect(ch.teaches).toHaveLength(1)
    expect(ch.teaches[0]).toMatchObject({ slug: 't1', title: 'Tutorial One' })
  })

  it('populates requires[] from outgoing edges', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers')
    expect(ch.requires).toHaveLength(1)
    expect(ch.requires[0]).toMatchObject({ slug: 'cap-services', name: 'CAP services' })
  })

  it('populates requiredBy[] from incoming edges', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const cs = payload.concepts.find(c => c.slug === 'cap-services')
    expect(cs.requiredBy).toHaveLength(1)
    expect(cs.requiredBy[0]).toMatchObject({ slug: 'cap-handlers', name: 'CAP handlers' })
  })

  it('includes generatedAt timestamp', async () => {
    const payload = await buildConceptsPayload(cds.db)
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('excludes VETOED concepts even when publishedAt is set', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const slugs = payload.concepts.map(c => c.slug)
    expect(slugs).not.toContain('vetoed-but-published')
  })

  it('lowercases all emitted slugs (canonical form)', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims')

    await INSERT.into(Concepts).entries({
      slug: 'Mixed-Case-Concept', name: 'Mixed', description: 'm',
      status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com',
    })
    await INSERT.into(Tutorials).entries({
      slug: 'Mixed-Case-Tut', title: 'Mixed Tut', status: 'ACTIVE',
    })

    const cRow = await SELECT.one.from(Concepts).columns('ID')
      .where({ slug: 'Mixed-Case-Concept' })
    const tRow = await SELECT.one.from(Tutorials).columns('ID')
      .where({ slug: 'Mixed-Case-Tut' })

    await INSERT.into(TutorialConceptLinks).entries({
      tutorial_ID: tRow.ID, concept_ID: cRow.ID, predicate: 'teaches',
    })

    const payload = await buildConceptsPayload(cds.db)
    const got = payload.concepts.find(p => p.slug === 'mixed-case-concept')
    expect(got).toBeTruthy()
    expect(got.slug).toBe('mixed-case-concept')           // top-level
    expect(got.teaches[0].slug).toBe('mixed-case-tut')    // nested
  })
})
