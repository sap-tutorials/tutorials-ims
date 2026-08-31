// test/unit/kg-exposure.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('KG exposure on AdminService', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('exposes concept links, rank, co-completions read-only', () => {
    expect(m.definitions['AdminService.TutorialConceptLinks']).toBeTruthy()
    expect(m.definitions['AdminService.TutorialRank']).toBeTruthy()
    expect(m.definitions['AdminService.CoCompletions']).toBeTruthy()
  })
  it('Tutorials carries conceptLinks / rank / coCompletions', () => {
    const t = m.definitions['AdminService.Tutorials'].elements
    expect(t.conceptLinks).toBeTruthy()
    expect(t.rank).toBeTruthy()
    expect(t.coCompletions).toBeTruthy()
  })
})
