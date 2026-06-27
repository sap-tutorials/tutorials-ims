import cds from '@sap/cds'
import { describe, it, beforeAll, expect } from 'vitest'

// Boot the CAP server bound to hybrid HANA so we can invoke the neighborhood
// function through KnowledgeGraphService (read-only; no fixture writes).
cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('neighborhood handler exposes concept.published', () => {
  let kg

  beforeAll(async () => {
    kg = await cds.connect.to('KnowledgeGraphService')
  })

  it('every concept in teaches[] has a `published` boolean', async () => {
    const sample = await SELECT.one
      .from('com.sap.developers.ims.TutorialConceptLinks')
      .columns('tutorial.slug as slug')
      .where({ predicate: 'teaches' })
    if (!sample) {
      console.warn('[skip] No TutorialConceptLinks with predicate=teaches on bound HANA')
      return
    }
    const user = new cds.User.Privileged()
    const result = await kg.tx({ user }, (tx) => tx.send('neighborhood', { slug: sample.slug }))
    const teaches = result?.teaches ?? []
    expect(Array.isArray(teaches)).toBe(true)
    if (teaches.length === 0) return
    for (const c of teaches) {
      expect(c).toHaveProperty('published')
      expect(typeof c.published).toBe('boolean')
    }
  })
})

