import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchWithRetry } from '../parsers/github.js'

const realFetch = global.fetch

function mkResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    global.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('returns immediately on 2xx without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkResponse(200, 'ok'))
    global.fetch = fetchMock as any

    const promise = fetchWithRetry('https://example.test/ok', {}, { label: 'test' })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx and eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mkResponse(503))
      .mockResolvedValueOnce(mkResponse(502))
      .mockResolvedValueOnce(mkResponse(200, 'recovered'))
    global.fetch = fetchMock as any

    const promise = fetchWithRetry('https://example.test/flaky', {}, { label: 'test', retries: 5 })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries on 429 and honors numeric Retry-After', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mkResponse(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(mkResponse(200, 'ok'))
    global.fetch = fetchMock as any

    const promise = fetchWithRetry('https://example.test/throttled', {}, { label: 'test', retries: 3 })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 4xx other than 429 immediately (fail-fast)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkResponse(404, 'not found'))
    global.fetch = fetchMock as any

    const promise = fetchWithRetry('https://example.test/missing', {}, { label: 'test', retries: 5 })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on network errors then surfaces final failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    global.fetch = fetchMock as any

    const promise = fetchWithRetry('https://example.test/down', {}, { label: 'test', retries: 3 })
    const expectation = expect(promise).rejects.toThrow(/ECONNRESET|after 3 attempts/)
    await vi.runAllTimersAsync()
    await expectation

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns the last response after exhausting retries on 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkResponse(503, 'still down'))
    global.fetch = fetchMock as any

    const promise = fetchWithRetry('https://example.test/down', {}, { label: 'test', retries: 3 })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
