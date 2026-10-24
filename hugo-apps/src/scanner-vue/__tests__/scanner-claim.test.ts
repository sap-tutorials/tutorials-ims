// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useScannerApi } from '../useScannerApi'

afterEach(() => { vi.restoreAllMocks() })

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): any {
  const lower: Record<string, string> = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

// A CSRF-token fetch handshake response: the approuter answers the probe GET
// with the token in the `x-csrf-token` header and an empty body.
function csrfTokenResponse(token = 'tok-123'): any {
  return jsonResponse({}, 200, { 'x-csrf-token': token })
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
    // The approuter enforces CSRF on writes (/scanner/* has no csrfProtection:false),
    // so the client first fetches a token (GET x-csrf-token: fetch) then POSTs with it.
    it('fetches a CSRF token then POSTs the action with the token header (#badge-v2)', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(csrfTokenResponse('tok-abc'))
        .mockResolvedValueOnce(jsonResponse({ claimedCount: 1, message: 'Prize recorded!' }))
      vi.stubGlobal('fetch', fetchSpy as any)

      const { claimPrizeForContestant } = useScannerApi()
      await claimPrizeForContestant('test-uuid-456', 10000015)

      expect(fetchSpy).toHaveBeenCalledTimes(2)

      // Call 1: token fetch (GET, x-csrf-token: fetch)
      const [tokenUrl, tokenInit]: [string, RequestInit] = fetchSpy.mock.calls[0] as any
      expect(tokenUrl).toMatch(/^\/scanner\//)
      expect((tokenInit.headers as Record<string, string>)['x-csrf-token']).toBe('fetch')

      // Call 2: the claim POST carries the harvested token
      const [url, init]: [string, RequestInit] = fetchSpy.mock.calls[1] as any
      expect(url).toBe('/scanner/claimPrizeForContestant')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok-abc')
      expect(JSON.parse(init.body as string)).toEqual({ accountNumber: 'test-uuid-456', eventId: 10000015 })
    })

    it('refetches the token and retries once on a 403 CSRF challenge', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(csrfTokenResponse('stale'))
        // POST rejected: token expired — approuter signals re-fetch required
        .mockResolvedValueOnce(jsonResponse({}, 403, { 'x-csrf-token': 'Required' }))
        .mockResolvedValueOnce(csrfTokenResponse('fresh'))
        .mockResolvedValueOnce(jsonResponse({ claimedCount: 2, message: 'prize 2 of 2 recorded' }))
      vi.stubGlobal('fetch', fetchSpy as any)

      const { claimPrizeForContestant } = useScannerApi()
      const result = await claimPrizeForContestant('uid-xyz', 10000015)

      expect(fetchSpy).toHaveBeenCalledTimes(4)
      expect((fetchSpy.mock.calls[3][1].headers as Record<string, string>)['x-csrf-token']).toBe('fresh')
      expect(result.claimedCount).toBe(2)
    })

    it('returns claimedCount and message from the response', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(csrfTokenResponse())
        .mockResolvedValueOnce(jsonResponse({ claimedCount: 2, message: 'Max prizes reached' })) as any)

      const { claimPrizeForContestant } = useScannerApi()
      const result = await claimPrizeForContestant('uid-xyz', 10000015)

      expect(result.claimedCount).toBe(2)
      expect(result.message).toBe('Max prizes reached')
    })

    it('unwraps OData value envelope', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(csrfTokenResponse())
        .mockResolvedValueOnce(jsonResponse({ value: { claimedCount: 1, message: 'Done' } })) as any)

      const { claimPrizeForContestant } = useScannerApi()
      const result = await claimPrizeForContestant('uid-xyz', 10000015)

      expect(result.claimedCount).toBe(1)
      expect(result.message).toBe('Done')
    })

    it('throws on non-ok response (non-CSRF)', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(csrfTokenResponse())
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'Max prizes already claimed' } }, 400)) as any)

      const { claimPrizeForContestant } = useScannerApi()
      await expect(claimPrizeForContestant('uid-xyz', 10000015))
        .rejects.toThrow('Max prizes already claimed')
    })
  })
})
