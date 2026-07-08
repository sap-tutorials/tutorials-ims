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

  it('rejects a duplicate (concept, aliasLower) pair', async () => {
    // First insert of 'IDoc' happens in the earlier `it`. This is 'idoc'.
    await expect(project.post('/graph/ConceptAliases', {
      concept_ID: conceptId,
      alias: 'idoc',
      source: 'ADMIN'
    })).rejects.toThrow(/unique|assert/i)
  })

  it('allows the same alias on a different concept', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    await INSERT.into(Concepts).entries({
      slug: 'test-concept-1046-b',
      name: 'Test Concept 1046 B',
      status: 'ACTIVE'
    })
    const otherId = (await SELECT.one.from(Concepts).where({ slug: 'test-concept-1046-b' })).ID
    const { data } = await project.post('/graph/ConceptAliases', {
      concept_ID: otherId,
      alias: 'IDoc',
      source: 'ADMIN'
    })
    expect(data.aliasLower).toBe('idoc')
  })

  it('POST triggers after-write hook that materializes Concepts.aliasSearchBlob', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    // Seed a fresh concept — cannot reuse test-concept-1046 because earlier tests
    // have already altered its alias state.
    await INSERT.into(Concepts).entries({
      slug: 'test-concept-1046-blob',
      name: 'Test Concept Blob',
      status: 'ACTIVE'
    })
    const conceptId = (await SELECT.one.from(Concepts).where({ slug: 'test-concept-1046-blob' })).ID

    // POST through the OData service so the before-write (aliasLower) and
    // after-write (aliasSearchBlob re-aggregation) hooks both fire.
    const { data } = await project.post('/graph/ConceptAliases', {
      concept_ID: conceptId,
      alias: 'BlobTest',
      source: 'ADMIN'
    })
    expect(data.aliasLower).toBe('blobtest')

    // The after-write hook should have re-aggregated aliasSearchBlob on the parent.
    const row = await SELECT.one.from(Concepts).where({ ID: conceptId })
    expect(row.aliasSearchBlob).toMatch(/blobtest/)
  })
})
