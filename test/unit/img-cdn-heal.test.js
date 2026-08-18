import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createHealer } = require('../../approuter/lib/img-cdn-heal')

// Heal-on-request (issue #1882): when the approuter fail-opens to GitHub on a
// store miss, it fire-and-forgets the original bytes to POST /content/image so
// the store self-populates. These guards use an injected fetch/now/resolveSecret
// so there is no network, no real clock, and no credstore.

const SRV = 'https://srv.example.com'
const BUF = Buffer.from('PNGDATA')

function okFetch() {
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ action: 'stored' }) }
  })
  return { fetchImpl, calls }
}

describe('createHealer — heal-on-request', () => {
  it('POSTs original bytes to /content/image with Bearer key + content-type', async () => {
    const { fetchImpl, calls } = okFetch()
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl })

    await healer.heal('https://raw.githubusercontent.com/o/r/main/a.png', BUF, 'image/png')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      `${SRV}/content/image?u=${encodeURIComponent('https://raw.githubusercontent.com/o/r/main/a.png')}`,
    )
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer SEKRIT')
    expect(calls[0].init.headers['Content-Type']).toBe('image/png')
    expect(calls[0].init.body).toBe(BUF)
    // Channel is derived server-side (channelFor) — approuter never sends it.
    expect(calls[0].url).not.toContain('channel=')
  })

  it('dedups within the TTL window — a second heal of the same url does NOT re-POST', async () => {
    const { fetchImpl, calls } = okFetch()
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    let t = 1_000
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl, now: () => t, ttlMs: 60_000 })

    await healer.heal('https://x/a.png', BUF, 'image/png')
    t += 30_000 // still inside the window
    await healer.heal('https://x/a.png', BUF, 'image/png')

    expect(calls).toHaveLength(1)
  })

  it('re-heals after the TTL window expires', async () => {
    const { fetchImpl, calls } = okFetch()
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    let t = 1_000
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl, now: () => t, ttlMs: 60_000 })

    await healer.heal('https://x/a.png', BUF, 'image/png')
    t += 60_001 // window elapsed
    await healer.heal('https://x/a.png', BUF, 'image/png')

    expect(calls).toHaveLength(2)
  })

  it('keeps the dedup claim even when the POST fails (no re-POST hammering)', async () => {
    const calls = []
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init })
      return { ok: false, status: 503 }
    })
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    const warn = vi.fn()
    let t = 1_000
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl, warn, now: () => t, ttlMs: 60_000 })

    await healer.heal('https://x/a.png', BUF, 'image/png')
    t += 5_000
    await healer.heal('https://x/a.png', BUF, 'image/png')

    expect(calls).toHaveLength(1) // second miss suppressed by the held claim
    expect(warn).toHaveBeenCalled() // non-2xx is logged, not thrown
  })

  it('self-disables when CONTENT_API_KEY is unresolvable — no POST, no throw', async () => {
    const { fetchImpl, calls } = okFetch()
    const resolveSecret = vi.fn(async () => null)
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl })

    await expect(healer.heal('https://x/a.png', BUF, 'image/png')).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('never rejects when the fetch itself throws (fire-and-forget)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    const warn = vi.fn()
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl, warn })

    await expect(healer.heal('https://x/a.png', BUF, 'image/png')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('is a no-op for an empty/missing buffer or missing url', async () => {
    const { fetchImpl, calls } = okFetch()
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl })

    await healer.heal('https://x/a.png', Buffer.alloc(0), 'image/png')
    await healer.heal('https://x/a.png', undefined, 'image/png')
    await healer.heal('', BUF, 'image/png')

    expect(calls).toHaveLength(0)
    expect(resolveSecret).not.toHaveBeenCalled()
  })

  it('defaults missing content-type to application/octet-stream', async () => {
    const { fetchImpl, calls } = okFetch()
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    const healer = createHealer({ srvUrl: SRV, resolveSecret, fetchImpl })

    await healer.heal('https://x/a.png', BUF)

    expect(calls[0].init.headers['Content-Type']).toBe('application/octet-stream')
  })

  it('caps the dedup map size (evicts oldest) so it cannot grow unbounded', async () => {
    const { fetchImpl } = okFetch()
    const resolveSecret = vi.fn(async () => 'SEKRIT')
    let t = 1_000
    const healer = createHealer({
      srvUrl: SRV, resolveSecret, fetchImpl, now: () => t, ttlMs: 60_000, maxEntries: 3,
    })

    for (let i = 0; i < 5; i++) { await healer.heal(`https://x/${i}.png`, BUF, 'image/png') }

    expect(healer._recentSize()).toBeLessThanOrEqual(3)
  })
})
