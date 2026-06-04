// hugo-apps/src/shared/analytics/__tests__/tracker.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { _resetForTests, getSessionId, track, flush, _getBufferForTests } from '../tracker'

describe('tracker', () => {
  let mockStorage: Record<string, string>
  let mockSendBeacon: ReturnType<typeof vi.fn>
  let mockFetch: ReturnType<typeof vi.fn>
  let mockCryptoUuid: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockStorage = {}
    mockSendBeacon = vi.fn().mockReturnValue(true)
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    mockCryptoUuid = vi.fn().mockReturnValue('a3e0a8b1-1234-4567-89ab-cdef01234567')
    _resetForTests({
      sessionStorage: {
        getItem: (k: string) => mockStorage[k] ?? null,
        setItem: (k: string, v: string) => { mockStorage[k] = v },
        removeItem: (k: string) => { delete mockStorage[k] },
      },
      sendBeacon: mockSendBeacon,
      fetchFn: mockFetch as any,
      cryptoUuid: mockCryptoUuid,
      surface: '/',
      buildAt: 'test-build',
    })
  })
  afterEach(() => { vi.useRealTimers() })

  it('generates a sessionId on first call and persists it', () => {
    const id1 = getSessionId()
    const id2 = getSessionId()
    expect(id1).toBe('a3e0a8b1-1234-4567-89ab-cdef01234567')
    expect(id2).toBe(id1)
    expect(mockCryptoUuid).toHaveBeenCalledTimes(1)
  })

  it('reuses sessionId from storage if present', () => {
    mockStorage['analytics.sessionId'] = '11111111-2222-4333-8444-555555555555'
    const id = getSessionId()
    expect(id).toBe('11111111-2222-4333-8444-555555555555')
    expect(mockCryptoUuid).not.toHaveBeenCalled()
  })

  it('appends to buffer on track()', () => {
    track('page_view', { path: '/', referrer: '' })
    expect(_getBufferForTests()).toHaveLength(1)
    expect(_getBufferForTests()[0]).toMatchObject({
      eventType: 'page_view',
      surface: '/',
      payload: { path: '/', referrer: '' },
    })
  })

  it('flushes immediately on card_click', async () => {
    track('card_click', { cardType: 'tutorial', cardId: 'x', position: 0, source: 'grid' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mockSendBeacon).toHaveBeenCalledTimes(0) // sendBeacon only on pagehide
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(_getBufferForTests()).toHaveLength(0)
  })

  it('flushes after 30s timer', async () => {
    track('page_view', { path: '/', referrer: '' })
    expect(mockFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_001)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('uses sendBeacon on explicit flush({ via: "beacon" })', () => {
    track('page_view', { path: '/', referrer: '' })
    flush({ via: 'beacon' })
    expect(mockSendBeacon).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('falls back to fetch{keepalive:true} when sendBeacon returns false', () => {
    mockSendBeacon.mockReturnValue(false)
    track('page_view', { path: '/', referrer: '' })
    flush({ via: 'beacon' })
    expect(mockSendBeacon).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1]?.keepalive).toBe(true)
  })

  it('self-disables after 3 consecutive 5xx responses', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 })
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    // 3 calls so far; tracker now self-disabled
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(mockFetch).toHaveBeenCalledTimes(3) // 4th call short-circuited
  })

  it('drops batch on 4xx (no retry)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 })
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(_getBufferForTests()).toHaveLength(0) // dropped, not retained
  })

  it('serializes the batch with sessionId, events, buildAt fields', async () => {
    track('page_view', { path: '/', referrer: '' })
    await vi.advanceTimersByTimeAsync(30_001)
    const fetchCall = mockFetch.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.sessionId).toBe('a3e0a8b1-1234-4567-89ab-cdef01234567')
    expect(body.buildAt).toBe('test-build')
    expect(body.events).toHaveLength(1)
  })
})
