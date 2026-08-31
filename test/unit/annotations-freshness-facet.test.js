// test/unit/annotations-freshness-facet.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('Freshness reports facet', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('Tutorials has freshnessReports association', () => {
    expect(m.definitions['AdminService.Tutorials'].elements.freshnessReports).toBeTruthy()
  })
  it('OP facets include FreshnessReportsFacet', () => {
    const ids = m.definitions['AdminService.Tutorials']['@UI.Facets'].map((f) => f.ID)
    expect(ids).toContain('FreshnessReportsFacet')
  })
})
