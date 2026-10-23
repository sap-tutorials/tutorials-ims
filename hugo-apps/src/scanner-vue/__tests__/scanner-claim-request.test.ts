// #badge-v2 — claimPrizeForContestant is an OData `action`, so it must be a POST
// with params in the body, NOT a function-style GET with params in the URL.
// claimRequest() builds that request; this pins the method/URL/body contract.

import { describe, expect, it } from 'vitest'
import { claimRequest } from '../useScannerApi'

describe('claimRequest action contract (#badge-v2)', () => {
  it('builds a POST with params in the body, not the URL', () => {
    const req = claimRequest('uuid-abc', 10000015)
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/scanner/claimPrizeForContestant')
    expect(req.url).not.toContain('accountNumber')
    expect(req.body).toEqual({ accountNumber: 'uuid-abc', eventId: 10000015 })
  })
})
