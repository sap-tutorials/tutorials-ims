// #badge-v2 — the API layer must coerce missing/null numeric fields to 0 so the
// card never renders "null of 2" (the bug) and defaults claimedPrizeNames to [].

import { describe, expect, it } from 'vitest'
import { normalizeContestant } from '../useScannerApi'

describe('normalizeContestant coercion (#badge-v2)', () => {
  it('coerces null claimedCount and completion counts to 0', () => {
    const r = normalizeContestant({ claimedCount: null, tutorialsCompleted: null })
    expect(r.claimedCount).toBe(0)
    expect(r.tutorialsCompleted).toBe(0)
    expect(r.groupsCompleted).toBe(0)
    expect(r.missionsCompleted).toBe(0)
  })

  it('defaults claimedPrizeNames to an empty array when missing', () => {
    const r = normalizeContestant({})
    expect(r.claimedPrizeNames).toEqual([])
  })

  it('preserves real values', () => {
    const r = normalizeContestant({
      lastName: 'Jung', firstInitial: 'T', claimedCount: 2,
      claimedPrizeNames: ['Sticker Pack'], tutorialsCompleted: 5,
    })
    expect(r.lastName).toBe('Jung')
    expect(r.firstInitial).toBe('T')
    expect(r.claimedCount).toBe(2)
    expect(r.claimedPrizeNames).toEqual(['Sticker Pack'])
    expect(r.tutorialsCompleted).toBe(5)
  })
})
