import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

describe('TutorialAssets model', () => {
  it('compiles with a filename column and an Attachments composition', async () => {
    const m = await cds.load(['db/tutorial-assets.cds'], { root: '.' })
    const e = cds.linked(m).definitions['com.sap.developers.ims.TutorialAssets']
    expect(e).toBeTruthy()
    expect(e.elements.sourceUrl.length).toBe(1024)
    expect(e.elements.filename).toBeTruthy()
    expect(e.elements.content.type).toBe('cds.Composition')
  })
})
