import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

// KnowledgeGraphService has a before('*') gate that returns 503 when the
// feature flag is off — flip it on before the server starts.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true'

const project = cds.test('serve', '--project', '.', '--in-memory')

describe('#1046 PublishedConceptsWithAliases', () => {
  let conceptId
  beforeAll(async () => {
    const { Concepts, ConceptAliases } = cds.entities('com.sap.developers.ims')
    await INSERT.into(Concepts).entries({
      slug: 'sap-landscape-transformation',
      name: 'SAP Landscape Transformation',
      description: 'SLT replication server for SAP HANA and S/4HANA.',
      status: 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publishedBy: 'test'
    })
    const row = await SELECT.one.from(Concepts).where({ slug: 'sap-landscape-transformation' })
    conceptId = row.ID
    await INSERT.into(ConceptAliases).entries([
      { concept_ID: conceptId, alias: 'SLT',      aliasLower: 'slt',      source: 'SEED' },
      { concept_ID: conceptId, alias: 'S/4HANA',  aliasLower: 's/4hana',  source: 'SEED' }
    ])
    // Seed data bypasses the after-write hook (it uses cds.run INSERT directly).
    // Manually populate aliasSearchBlob to match what the hook would have written.
    await UPDATE(Concepts).set({ aliasSearchBlob: 'slt,s/4hana' }).where({ ID: conceptId })

    // Alias-only match concept — 'IDoc' does NOT appear anywhere in name or description.
    // This is the honest guard: $search=IDoc must match solely through aliasSearchBlob.
    await INSERT.into(Concepts).entries({
      slug: 'intermediate-document',
      name: 'Intermediate Document',
      description: 'EDI standard exchange format for cross-system integration',
      status: 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publishedBy: 'test'
    })
    const idocRow = await SELECT.one.from(Concepts).where({ slug: 'intermediate-document' })
    await INSERT.into(ConceptAliases).entries({
      concept_ID: idocRow.ID,
      alias: 'IDoc',
      aliasLower: 'idoc',
      source: 'SEED'
    })
    // Manually populate aliasSearchBlob since the direct INSERT bypasses the after-write hook.
    await UPDATE(Concepts).set({ aliasSearchBlob: 'idoc' }).where({ ID: idocRow.ID })
  })

  it('hydrates aliasSearchBlob on read', async () => {
    const { data } = await project.get('/graph/PublishedConceptsWithAliases?$top=6&$select=slug,name,aliasSearchBlob')
    const row = data.value.find(r => r.slug === 'sap-landscape-transformation')
    expect(row).toBeDefined()
    expect(row.aliasSearchBlob).toMatch(/slt/)
    expect(row.aliasSearchBlob).toMatch(/s\/4hana/)
  })

  it('matches "SLT" via $search when the alias is present', async () => {
    const { data } = await project.get('/graph/PublishedConceptsWithAliases?$search=SLT&$top=6')
    const slugs = (data.value || []).map(r => r.slug)
    expect(slugs).toContain('sap-landscape-transformation')
  })

  it('matches "slt" (case-insensitive)', async () => {
    const { data } = await project.get('/graph/PublishedConceptsWithAliases?$search=slt&$top=6')
    const slugs = (data.value || []).map(r => r.slug)
    expect(slugs).toContain('sap-landscape-transformation')
  })

  it('returns empty for a nonsense query', async () => {
    const { data } = await project.get('/graph/PublishedConceptsWithAliases?$search=xyzzy-nomatch&$top=6')
    expect(data.value).toEqual([])
  })

  // Honest alias-only guard: 'IDoc' appears neither in name ('Intermediate Document')
  // nor description ('EDI standard exchange format for cross-system integration').
  // A match here proves aliasSearchBlob is actually driving the $search result —
  // not the name/description columns.
  it('matches "IDoc" via alias when neither name nor description contain "IDoc"', async () => {
    const { data } = await project.get('/graph/PublishedConceptsWithAliases?$search=IDoc&$top=6')
    const slugs = (data.value || []).map(r => r.slug)
    expect(slugs).toContain('intermediate-document')
  })
})

