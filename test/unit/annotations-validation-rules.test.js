import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('validation rules exposure + facet', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('AdminService exposes TutorialValidationRules read-only', () => {
    expect(m.definitions['AdminService.TutorialValidationRules']).toBeTruthy()
  })
  it('Tutorials has validationRules association', () => {
    expect(m.definitions['AdminService.Tutorials'].elements.validationRules).toBeTruthy()
  })
  it('OP facets include an All Validation Rules facet', () => {
    const facets = m.definitions['AdminService.Tutorials']['@UI.Facets']
    const ids = facets.map((f) => f.ID)
    expect(ids).toContain('AllValidationRulesFacet')
  })
})
