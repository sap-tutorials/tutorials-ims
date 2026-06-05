// hugo-apps/src/tutorial-referred/__tests__/referred-view.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../shared/analytics/tracker', () => ({
  track: vi.fn(),
  init: vi.fn(),
}))

import { fireReferredView } from '../../shared/analytics/referred-view'
import { track, init as initTracker } from '../../shared/analytics/tracker'

describe('referred-view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    ;(window as any).__BROWSE_BUILD_AT = 'test-build'
  })

  it('fires once per page load when sessionId is in sessionStorage', () => {
    sessionStorage.setItem('analytics.sessionId', '11111111-2222-4333-8444-555555555555')
    fireReferredView('cap-getting-started')
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('referred_view', expect.any(Object))
  })

  it('does NOT fire when sessionId is absent (no cross-tab leak)', () => {
    // sessionStorage is empty (cleared in beforeEach) — new tab scenario
    fireReferredView('cap-getting-started')
    expect(track).not.toHaveBeenCalled()
  })

  it('payload contains tutorialSlug, fromSurface, fromCardId from analytics.lastClick', () => {
    sessionStorage.setItem('analytics.sessionId', '11111111-2222-4333-8444-555555555555')
    sessionStorage.setItem('analytics.lastClick', JSON.stringify({
      fromSurface: '/browse/',
      fromCardId: 'cap-getting-started',
      ts: 1717527600000,
    }))
    fireReferredView('cap-getting-started')
    expect(track).toHaveBeenCalledWith('referred_view', {
      tutorialSlug: 'cap-getting-started',
      fromSurface: '/browse/',
      fromCardId: 'cap-getting-started',
    })
  })

  it("uses surface='/tutorials/' (initTracker called before track)", () => {
    sessionStorage.setItem('analytics.sessionId', '11111111-2222-4333-8444-555555555555')
    fireReferredView('cap-getting-started')
    // Verify initTracker called with /tutorials/ surface
    expect(initTracker).toHaveBeenCalledWith({ surface: '/tutorials/', buildAt: 'test-build' })
    // Verify track was called after initTracker
    expect(track).toHaveBeenCalledTimes(1)
    const initOrder = (initTracker as any).mock.invocationCallOrder[0]
    const trackOrder = (track as any).mock.invocationCallOrder[0]
    expect(initOrder).toBeLessThan(trackOrder)
  })
})
