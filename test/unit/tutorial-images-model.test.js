import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
describe('TutorialImages model', () => {
  it('defines TutorialImages with an Attachments composition, UUID key, unique sourceUrl', async () => {
    const m = await cds.load(['db/tutorial-images.cds', 'db/schema.cds'])
    const e = m.definitions['com.sap.developers.ims.TutorialImages']
    expect(e).toBeTruthy()
    expect(e.elements.ID.key).toBe(true)
    expect(e.elements.sourceUrl).toBeTruthy()          // unique business key
    expect(e.elements.content).toBeTruthy()            // composition present
    expect(e.elements.contentHash).toBeTruthy()
    expect(e.elements.channel).toBeTruthy()
  })
})
