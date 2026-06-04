// hugo-apps/src/shared/analytics/__tests__/wire-tracker.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tracker', () => ({
  init: vi.fn(),
  track: vi.fn(),
  flush: vi.fn(),
}))
vi.mock('../page-events', () => ({
  wirePageEvents: vi.fn(),
}))
vi.mock('../card-events', () => ({
  wireCardEvents: vi.fn(),
}))
vi.mock('../filter-events', () => ({
  wireFilterEvents: vi.fn(),
}))

import { init as initTracker } from '../tracker'
import { wirePageEvents } from '../page-events'
import { wireCardEvents } from '../card-events'
import { wireFilterEvents } from '../filter-events'
import { wireTracker } from '../wire-tracker'

describe('wire-tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).__BROWSE_BUILD_AT = 'build-123'
  })

  it('calls initTracker, wirePageEvents, wireCardEvents synchronously', () => {
    wireTracker({ surface: '/' })
    expect(initTracker).toHaveBeenCalledWith({ surface: '/', buildAt: 'build-123' })
    expect(wirePageEvents).toHaveBeenCalledWith('/')
    expect(wireCardEvents).toHaveBeenCalledWith('/')
  })

  it('does NOT lazy-import filter-events when filters opt is missing', async () => {
    wireTracker({ surface: '/tutorials/' })
    await new Promise(r => setTimeout(r, 0))
    expect(wireFilterEvents).not.toHaveBeenCalled()
  })

  it('lazy-imports filter-events when filters opt is provided', async () => {
    const filters = { searchQuery: { value: '' } }
    wireTracker({ surface: '/browse/', filters })
    // Lazy import resolves on next microtask
    await new Promise(r => setTimeout(r, 0))
    expect(wireFilterEvents).toHaveBeenCalledWith({ filters, surface: '/browse/' })
  })

  it('uses empty buildAt when window.__BROWSE_BUILD_AT is unset', () => {
    delete (window as any).__BROWSE_BUILD_AT
    wireTracker({ surface: '/' })
    expect(initTracker).toHaveBeenCalledWith({ surface: '/', buildAt: '' })
  })
})
