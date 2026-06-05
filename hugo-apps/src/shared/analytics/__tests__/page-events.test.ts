// hugo-apps/src/shared/analytics/__tests__/page-events.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../tracker', () => ({
  track: vi.fn(),
  flush: vi.fn(),
}))

import { track, flush } from '../tracker'
import { wirePageEvents, _resetForTests } from '../page-events'

describe('page-events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTests()
    // Reset DOM scroll geometry
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0, writable: true })
  })
  afterEach(() => {
    _resetForTests()
  })

  it('fires page_view immediately on wirePageEvents', () => {
    Object.defineProperty(document, 'referrer', { configurable: true, value: 'https://example.com/foo' })
    Object.defineProperty(window, 'location', { configurable: true, value: { pathname: '/browse/' } })
    wirePageEvents('/browse/')
    expect(track).toHaveBeenCalledWith('page_view', expect.objectContaining({
      path: '/browse/',
      referrer: 'https://example.com/foo',
    }))
  })

  it('fires page_leave + flush({via:"beacon"}) on pagehide', () => {
    wirePageEvents('/')
    vi.clearAllMocks() // ignore the page_view call
    window.dispatchEvent(new Event('pagehide'))
    expect(track).toHaveBeenCalledWith('page_leave', expect.objectContaining({
      durationMs: expect.any(Number),
      eventCount: expect.any(Number),
    }))
    expect(flush).toHaveBeenCalledWith({ via: 'beacon' })
  })

  it('fires scroll_depth once when crossing 25% threshold', () => {
    wirePageEvents('/')
    vi.clearAllMocks()
    // scrollHeight 2000, innerHeight 500. (scrollY+innerHeight)/scrollHeight = 25% at scrollY=0 already.
    // Bump geometry to make starting position < 25%
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 4000 })
    // (0 + 500) / 4000 = 12.5% on dispatch → no fire
    window.dispatchEvent(new Event('scroll'))
    expect(track).not.toHaveBeenCalled()
    // Cross 25%: scrollY 600 → (600+500)/4000 = 27.5%
    ;(window as any).scrollY = 600
    window.dispatchEvent(new Event('scroll'))
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('scroll_depth', { maxPercent: 25 })
  })

  it('does not fire scroll_depth twice for the same threshold', () => {
    wirePageEvents('/')
    vi.clearAllMocks()
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 4000 })
    ;(window as any).scrollY = 600
    window.dispatchEvent(new Event('scroll'))
    ;(window as any).scrollY = 700
    window.dispatchEvent(new Event('scroll'))
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('scroll_depth', { maxPercent: 25 })
  })

  it('is idempotent — calling wirePageEvents twice only registers one set of listeners', () => {
    wirePageEvents('/')
    wirePageEvents('/')
    // page_view fires once per call (by design — it's the immediate "this happened" event)
    // but listeners (pagehide, scroll) are only registered once
    vi.clearAllMocks()
    window.dispatchEvent(new Event('pagehide'))
    expect(track).toHaveBeenCalledTimes(1) // single page_leave
    expect(flush).toHaveBeenCalledTimes(1) // single flush
  })
})
