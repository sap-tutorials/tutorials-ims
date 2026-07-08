import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

// KnowledgeGraphService has a before('*') gate that returns 503 when the
// feature flag is off — flip it on before the server starts.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true'

const project = cds.test('serve', '--project', '.', '--in-memory')

describe('#1046 KnowledgeGraphService.ConceptAliases', () => {
  let conceptId
  beforeAll(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    // Seed one concept the tests can hang aliases off.
    await INSERT.into(Concepts).entries({
      slug: 'test-concept-1046',
      name: 'Test Concept 1046',
      description: 'seed',
      status: 'ACTIVE'
    })
    const row = await SELECT.one.from(Concepts).where({ slug: 'test-concept-1046' })
    conceptId = row.ID
  })

  it('exposes /graph/ConceptAliases as writable', async () => {
    const { data } = await project.post('/graph/ConceptAliases', {
      concept_ID: conceptId,
      alias: 'IDoc',
      source: 'ADMIN'
    })
    expect(data.alias).toBe('IDoc')
    expect(data.aliasLower).toBe('idoc')  // Task 4 will make this pass; expect a fail here.
  })
})
