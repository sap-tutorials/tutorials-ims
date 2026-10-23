// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useScannerApi } from '../useScannerApi'

afterEach(() => { vi.restoreAllMocks() })

function jsonResponse(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('useScannerApi', () => {
  describe('getContestant(uid, eventId)', () => {
    it('builds URL with accountNumber and eventId', async () => {
      const fetchSpy = vi.fn(async () =>
        jsonResponse({ tutorialsCompleted: 3, groupsCompleted: 1, missionsCompleted: 0, claimedCount: 1, prizeRecords: '' })
      )
      vi.stubGlobal('fetch', fetchSpy as any)

      const { getContestant } = useScannerApi()
      await getContestant('test-uuid-123', 10000015)

      expect(fetchSpy).toHaveBeenCalledOnce()
      const url: string = fetchSpy.mock.calls[0][0]
      expect(url).toBe("/scanner/getContestant(accountNumber='test-uuid-123',eventId=10000015)")
    })

    it('returns claimedCount from the response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ tutorialsCompleted: 2, groupsCompleted: 0, missionsCompleted: 1, claimedCount: 2, prizeRecords: 'T-shirt' })
      ) as any)

      const { getContestant } = useScannerApi()
      const result = await getContestant('uid-abc', 10000015)

      expect(result.claimedCount).toBe(2)
      expect(result.tutorialsCompleted).toBe(2)
    })

    it('unwraps OData value envelope', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ value: { tutorialsCompleted: 5, groupsCompleted: 2, missionsCompleted: 1, claimedCount: 0, prizeRecords: '' } })
      ) as any)

      const { getContestant } = useScannerApi()
      const result = await getContestant('uid-abc', 10000015)

      expect(result.claimedCount).toBe(0)
      expect(result.tutorialsCompleted).toBe(5)
    })
  })

  describe('claimPrizeForContestant(uid, eventId)', () => {
    it('POSTs to the action with params in the body (#badge-v2)', async () => {
      const fetchSpy = vi.fn(async () =>
        jsonResponse({ claimedCount: 1, message: 'Prize recorded!' })
      )
      vi.stubGlobal('fetch', fetchSpy as any)

      const { claimPrizeForContestant } = useScannerApi()
      await claimPrizeForContestant('test-uuid-456', 10000015)

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, init]: [string, RequestInit] = fetchSpy.mock.calls[0] as any
      expect(url).toBe('/scanner/claimPrizeForContestant')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({ accountNumber: 'test-uuid-456', eventId: 10000015 })
    })

    it('returns claimedCount and message from the response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ claimedCount: 2, message: 'Max prizes reached' })
      ) as any)

      const { claimPrizeForContestant } = useScannerApi()
      const result = await claimPrizeForContestant('uid-xyz', 10000015)

      expect(result.claimedCount).toBe(2)
      expect(result.message).toBe('Max prizes reached')
    })

    it('unwraps OData value envelope', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ value: { claimedCount: 1, message: 'Done' } })
      ) as any)

      const { claimPrizeForContestant } = useScannerApi()
      const result = await claimPrizeForContestant('uid-xyz', 10000015)

      expect(result.claimedCount).toBe(1)
      expect(result.message).toBe('Done')
    })

    it('throws on non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ error: { message: 'Max prizes already claimed' } }, 400)
      ) as any)

      const { claimPrizeForContestant } = useScannerApi()
      await expect(claimPrizeForContestant('uid-xyz', 10000015))
        .rejects.toThrow('Max prizes already claimed')
    })
  })
})
