import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  csrfFetch,
  CsrfFetchError,
  _resetCsrfTokenCacheForTests,
  _getCsrfTokenForTests,
} from './csrf-fetch'

// A minimal Response factory so tests don't depend on the real Fetch API's
// internals (jsdom's Response supports .headers.get which is all we need).
function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  body: string | undefined = undefined,
): Response {
  return new Response(body, { status, headers })
}

describe('csrfFetch', () => {
  beforeEach(() => {
    _resetCsrfTokenCacheForTests()
  })

  it('passes GET requests through without fetching a token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, {}, 'ok'))
    vi.stubGlobal('fetch', fetchMock)

    const res = await csrfFetch('/api/thing')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/thing')
    const init = fetchMock.mock.calls[0][1] ?? {}
    expect(init.credentials).toBe('include')
    // No csrf handshake for a safe method.
    const sentHeaders = new Headers(init.headers)
    expect(sentHeaders.get('x-csrf-token')).toBeNull()
  })

  it('passes HEAD and OPTIONS through without fetching a token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    await csrfFetch('/api/thing', { method: 'HEAD' })
    await csrfFetch('/api/thing', { method: 'OPTIONS' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fetches a token before the first POST and reuses it for the second', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      // First call is the /auth/user token fetch.
      if (url === '/auth/user') {
        expect((init?.headers as Record<string, string>)?.['x-csrf-token']).toBe('fetch')
        return makeResponse(200, { 'x-csrf-token': 'ABC123' }, '{"id":"u1"}')
      }
      // Subsequent calls are the real POSTs.
      const sent = new Headers(init?.headers)
      expect(sent.get('x-csrf-token')).toBe('ABC123')
      return makeResponse(201)
    })
    vi.stubGlobal('fetch', fetchMock)

    await csrfFetch('/api/setLearningPreferences', {
      method: 'POST',
      body: JSON.stringify({ foo: 1 }),
    })
    await csrfFetch('/api/completeStep', {
      method: 'POST',
      body: JSON.stringify({ step: 2 }),
    })

    // 1 token fetch + 2 real POSTs.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(_getCsrfTokenForTests()).toBe('ABC123')
  })

  it('retries once on 403 x-csrf-token: required with a fresh token', async () => {
    let tokenCall = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/user') {
        tokenCall++
        return makeResponse(
          200,
          { 'x-csrf-token': tokenCall === 1 ? 'STALE' : 'FRESH' },
        )
      }
      const sent = new Headers(init?.headers)
      const t = sent.get('x-csrf-token')
      if (t === 'STALE') {
        return makeResponse(403, { 'x-csrf-token': 'required' })
      }
      if (t === 'FRESH') return makeResponse(200)
      return makeResponse(500)
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await csrfFetch('/api/x', { method: 'POST' })
    expect(res.status).toBe(200)
    // Two token fetches (initial + refresh) + two POSTs (fail + retry) = 4.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(_getCsrfTokenForTests()).toBe('FRESH')
  })

  it('does NOT retry a second time — a persistent 403 propagates to the caller', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/auth/user') {
        return makeResponse(200, { 'x-csrf-token': 'ANY' })
      }
      return makeResponse(403, { 'x-csrf-token': 'required' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await csrfFetch('/api/x', { method: 'POST' })
    expect(res.status).toBe(403)
    // 2 token fetches + 2 POSTs = 4. Not more.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry on a 403 without the required header (e.g. authz denial)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/auth/user') {
        return makeResponse(200, { 'x-csrf-token': 'T' })
      }
      return makeResponse(403, {} /* no x-csrf-token header */)
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await csrfFetch('/api/x', { method: 'POST' })
    expect(res.status).toBe(403)
    // 1 token fetch + 1 POST. No retry.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws CsrfFetchError if the token fetch fails', async () => {
    const fetchMock = vi.fn(async () => makeResponse(401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(csrfFetch('/api/x', { method: 'POST' })).rejects.toBeInstanceOf(
      CsrfFetchError,
    )
  })

  it('throws CsrfFetchError if /auth/user returns 200 without the token header', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(csrfFetch('/api/x', { method: 'POST' })).rejects.toBeInstanceOf(
      CsrfFetchError,
    )
  })

  it('preserves caller-supplied headers and Content-Type', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/user') {
        return makeResponse(200, { 'x-csrf-token': 'T' })
      }
      const sent = new Headers(init?.headers)
      expect(sent.get('content-type')).toBe('application/json')
      expect(sent.get('x-custom')).toBe('yes')
      expect(sent.get('x-csrf-token')).toBe('T')
      return makeResponse(204)
    })
    vi.stubGlobal('fetch', fetchMock)

    await csrfFetch('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'yes' },
      body: '{}',
    })
  })

  it('respects caller-supplied credentials override on the mutating request', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/user') {
        // Internal token fetch always uses include, not the caller's choice.
        expect(init?.credentials).toBe('include')
        return makeResponse(200, { 'x-csrf-token': 'T' })
      }
      // The wrapped user request must honour the caller's override.
      expect(init?.credentials).toBe('same-origin')
      return makeResponse(204)
    })
    vi.stubGlobal('fetch', fetchMock)

    await csrfFetch('/api/x', { method: 'POST', credentials: 'same-origin' })
  })

  it('treats `x-csrf-token: Required` (case variance) the same as `required`', async () => {
    let tokenCall = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/auth/user') {
        tokenCall++
        return makeResponse(
          200,
          { 'x-csrf-token': tokenCall === 1 ? 'STALE' : 'FRESH' },
        )
      }
      // Force one 403+Required then success.
      if (tokenCall === 1) {
        return makeResponse(403, { 'x-csrf-token': 'Required' })
      }
      return makeResponse(200)
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await csrfFetch('/api/x', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})
