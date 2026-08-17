import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { fetchImageResponse } = require('../../srv/lib/img-cdn-fetch.cjs')

// End-to-end guard for the mobile /img-cdn 429 fix: anonymous-first token
// policy + retry-on-429. Uses fake safeFetch/resolveSecret/sleep so no network
// or real timers are involved.
function fakeRes(status, { headers = {}, retryAfter } = {}) {
  const h = new Map(Object.entries(headers))
  if (retryAfter != null) h.set('retry-after', String(retryAfter))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
  }
}

const RAW = 'raw.githubusercontent.com'
const noSleep = () => Promise.resolve()

describe('fetchImageResponse — token policy + retry', () => {
  it('public image: fetches anonymously, never sends a token', async () => {
    const calls = []
    const safeFetch = async (u, opts) => { calls.push(opts.fetchInit.headers); return fakeRes(200) }
    let tokenAsked = false
    const resolveSecret = async () => { tokenAsked = true; return 'SECRET' }

    const res = await fetchImageResponse('https://x/y.png', {
      safeFetch, resolveSecret, host: RAW, allowedHosts: new Set([RAW]),
      timeoutMs: 1000, maxRetries: 2, sleep: noSleep,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].Authorization).toBeUndefined()
    expect(tokenAsked).toBe(false) // token never resolved for a public 200
  })

  it('private QA repo (anon 404): retries WITH the token and succeeds', async () => {
    const calls = []
    const safeFetch = async (u, opts) => {
      calls.push(opts.fetchInit.headers)
      return calls.length === 1 ? fakeRes(404) : fakeRes(200)
    }
    const resolveSecret = async () => 'QA-TOKEN'

    const res = await fetchImageResponse('https://x/qa.png', {
      safeFetch, resolveSecret, host: RAW, allowedHosts: new Set([RAW]),
      timeoutMs: 1000, maxRetries: 2, sleep: noSleep,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[0].Authorization).toBeUndefined()      // anon first
    expect(calls[1].Authorization).toBe('Bearer QA-TOKEN') // token fallback
  })

  it('anon 404 with no token available: returns the 404, no crash', async () => {
    const safeFetch = async () => fakeRes(404)
    const resolveSecret = async () => null // credstore miss

    const res = await fetchImageResponse('https://x/missing.png', {
      safeFetch, resolveSecret, host: RAW, allowedHosts: new Set([RAW]),
      timeoutMs: 1000, maxRetries: 2, sleep: noSleep,
    })
    expect(res.status).toBe(404)
  })

  it('retries a transient 429 then succeeds (the core mobile fix)', async () => {
    let n = 0
    const safeFetch = async () => { n++; return n < 3 ? fakeRes(429) : fakeRes(200) }
    const resolveSecret = async () => 'SECRET'
    const slept = []

    const res = await fetchImageResponse('https://x/y.png', {
      safeFetch, resolveSecret, host: RAW, allowedHosts: new Set([RAW]),
      timeoutMs: 1000, maxRetries: 2, sleep: (ms) => { slept.push(ms); return Promise.resolve() },
    })

    expect(res.status).toBe(200)
    expect(n).toBe(3)          // 429, 429, 200
    expect(slept).toHaveLength(2) // backed off before each retry
  })

  it('gives up after maxRetries and returns the last 429 (no infinite loop)', async () => {
    let n = 0
    const safeFetch = async () => { n++; return fakeRes(429) }
    const resolveSecret = async () => 'SECRET'

    const res = await fetchImageResponse('https://x/y.png', {
      safeFetch, resolveSecret, host: RAW, allowedHosts: new Set([RAW]),
      timeoutMs: 1000, maxRetries: 2, sleep: noSleep,
    })

    expect(res.status).toBe(429)
    expect(n).toBe(3) // 1 initial + 2 retries
  })

  it('a non-raw host never triggers the token fallback on 404', async () => {
    const safeFetch = async () => fakeRes(404)
    let tokenAsked = false
    const resolveSecret = async () => { tokenAsked = true; return 'SECRET' }

    const res = await fetchImageResponse('https://other/y.png', {
      safeFetch, resolveSecret, host: 'other.example.com', allowedHosts: new Set(['other.example.com']),
      timeoutMs: 1000, maxRetries: 2, sleep: noSleep,
    })
    expect(res.status).toBe(404)
    expect(tokenAsked).toBe(false)
  })
})
