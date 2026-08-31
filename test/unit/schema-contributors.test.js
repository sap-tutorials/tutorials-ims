// test/unit/schema-contributors.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('TutorialContributors schema', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('has GitHub link columns', () => {
    const e = m.definitions['com.sap.developers.ims.TutorialContributors']
    expect(e.elements.login).toBeTruthy()
    expect(e.elements.avatarUrl).toBeTruthy()
    expect(e.elements.profileUrl).toBeTruthy()
  })
})
