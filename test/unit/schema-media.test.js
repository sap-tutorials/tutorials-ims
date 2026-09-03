import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('media byteSize', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('images + assets have byteSize', () => {
    expect(m.definitions['com.sap.developers.ims.TutorialImages'].elements.byteSize).toBeTruthy()
    expect(m.definitions['com.sap.developers.ims.TutorialAssets'].elements.byteSize).toBeTruthy()
  })
})
