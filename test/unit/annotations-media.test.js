import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('Media facet', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('OP facets include Media', () => {
    const ids = m.definitions['AdminService.Tutorials']['@UI.Facets'].map((f) => f.ID)
    expect(ids).toContain('MediaImagesFacet')
    expect(ids).toContain('MediaAssetsFacet')
  })
  it('image LineItem shows sourceUrl + byteSize + mimeType', () => {
    const li = m.definitions['AdminService.TutorialImages']['@UI.LineItem']
    const vals = li.map((x) => x.Value?.['='] || x.Value)
    for (const c of ['sourceUrl','byteSize','mimeType','contentHash']) expect(vals).toContain(c)
  })
})
