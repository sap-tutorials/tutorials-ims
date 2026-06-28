import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js'

// Phase 4.1 (#447 §2.6): /build/concepts payload includes a per-concept
// learningJourneys array. This isolated suite (separate DB) seeds a journey
// + a link and asserts the row shape.
describe('buildConceptsPayload — learningJourneys field', () => {
  beforeAll(async () => {
    const schemaRoots = [
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]
    await cds.deploy(schemaRoots).to('sqlite::memory:')
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const { LearningJourneys, LearningJourneyConceptLinks } =
      cds.entities('com.sap.developers.ims.external')

    await INSERT.into(Concepts).entries([
      { slug: 'cap-handlers', name: 'CAP handlers', description: 'desc',
        status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
      { slug: 'no-journey', name: 'No Journey', description: 'desc',
        status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedBy: 'admin@sap.com' },
    ])
    const conceptRow = await SELECT.one.from(Concepts).columns('ID')
      .where({ slug: 'cap-handlers' })

    await INSERT.into(LearningJourneys).entries({
      slug: 'cap-quickstart',
      title: 'CAP Quickstart Journey',
      url: 'https://learning.sap.com/learning-journeys/cap-quickstart',
      level: 'intermediate',
      durationHours: 7.25,
    })
    const journeyRow = await SELECT.one.from(LearningJourneys).columns('ID')
      .where({ slug: 'cap-quickstart' })

    await INSERT.into(LearningJourneyConceptLinks).entries({
      journey_ID: journeyRow.ID, concept_ID: conceptRow.ID,
      predicate: 'covers', confidence: 0.9,
    })
  })

  afterAll(async () => {
    await cds.disconnect()
  })

  it('attaches learningJourneys[] on every concept (empty array when none)', async () => {
    const payload = await buildConceptsPayload(cds.db)
    for (const c of payload.concepts) {
      expect(c.learningJourneys).toBeDefined()
      expect(Array.isArray(c.learningJourneys)).toBe(true)
    }
  })

  it('populates learningJourneys with the joined journey row shape', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers')
    expect(ch.learningJourneys).toHaveLength(1)
    expect(ch.learningJourneys[0]).toMatchObject({
      slug: 'cap-quickstart',
      title: 'CAP Quickstart Journey',
      url: 'https://learning.sap.com/learning-journeys/cap-quickstart',
      level: 'intermediate',
    })
    // Decimal(5,2) — CDS may return number or string-equivalent; coerce.
    expect(Number(ch.learningJourneys[0].durationHours)).toBe(7.25)
  })

  it('returns empty learningJourneys[] for concepts with no journey', async () => {
    const payload = await buildConceptsPayload(cds.db)
    const nj = payload.concepts.find(c => c.slug === 'no-journey')
    expect(nj.learningJourneys).toEqual([])
  })
})
