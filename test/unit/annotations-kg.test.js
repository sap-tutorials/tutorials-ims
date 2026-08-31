import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('Knowledge Graph facets', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })

  it('OP facets include KG facets', () => {
    const ids = m.definitions['AdminService.Tutorials']['@UI.Facets'].map((f) => f.ID)
    expect(ids).toContain('ConceptsTaughtFacet')
    expect(ids).toContain('CoCompletionsFacet')
    expect(ids).toContain('KgCommunityFacet')
  })

  it('concept links LineItem shows predicate + confidence', () => {
    const li = m.definitions['AdminService.TutorialConceptLinks']['@UI.LineItem']
    const vals = li.map((x) => x.Value?.['='] || x.Value)
    expect(vals).toContain('predicate')
    expect(vals).toContain('confidence')
  })
})
