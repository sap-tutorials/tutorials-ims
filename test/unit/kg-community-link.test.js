import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('community label reachable', () => {
  let m
  beforeAll(async () => {
    m = await cds.load('*')
  })
  it('Tutorials exposes community membership or virtual label', () => {
    const t = m.definitions['AdminService.Tutorials'].elements
    expect(t.communityMembership || t.communityLabel).toBeTruthy()
  })
})
