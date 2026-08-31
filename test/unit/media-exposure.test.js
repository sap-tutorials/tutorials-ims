import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('media exposure', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('exposes images + assets read-only', () => {
    expect(m.definitions['AdminService.TutorialImages']).toBeTruthy()
    expect(m.definitions['AdminService.TutorialAssets']).toBeTruthy()
  })
  it('Tutorials has images + assets associations', () => {
    const t = m.definitions['AdminService.Tutorials'].elements
    expect(t.images).toBeTruthy()
    expect(t.assets).toBeTruthy()
  })
})
