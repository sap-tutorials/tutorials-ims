// @vitest-environment happy-dom
// hugo-apps/src/navigator/TutorialNavigator.joule.test.ts
//
// Contract test for issue #943 Task 7: the Joule handoff button inside the
// tutorial navigator search box. Mirrors the __JOULE_ADVOCATES pattern in
// hugo-apps/src/advocates/App.joule-handoff.test.ts.
//
// Assertions:
//   - Button is rendered with an aria-label reflecting the current searchQuery
//   - Empty query → window.joule.open() is called (not openWithMessage)
//   - Non-empty query → window.joule.openWithMessage() is called with the
//     canned template AND globalThis.__JOULE_NAV_SEARCH telemetry is set
//   - No throw when window.joule is undefined (graceful degradation)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TutorialNavigator from './TutorialNavigator.vue'

declare global {
  // eslint-disable-next-line no-var
  var __JOULE_NAV_SEARCH: unknown
}

// Stub fetch — the navigator's onMounted fires three fetches that would
// otherwise error out in happy-dom. Return minimal shapes so the component
// mounts without touching the real network.
function stubFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url === '/tutorials/_nav.json') {
      return { ok: true, json: async () => ({ tutorials: [] }) } as unknown as Response
    }
    if (url === '/build/navigator') {
      return { ok: true, json: async () => ({ missions: [], groups: [], tutorialMappings: [] }) } as unknown as Response
    }
    // /build/my-progress and anything else
    return { ok: false, json: async () => ({}) } as unknown as Response
  })
}

describe('TutorialNavigator Joule handoff button (#943)', () => {
  let openSpy: ReturnType<typeof vi.fn>
  let openWithMessageSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openSpy = vi.fn()
    openWithMessageSpy = vi.fn()
    ;(window as any).joule = { open: openSpy, openWithMessage: openWithMessageSpy }
    delete (globalThis as any).__JOULE_NAV_SEARCH
    globalThis.fetch = stubFetch() as unknown as typeof globalThis.fetch
  })

  it('renders the button with an aria-label reflecting the current search term', async () => {
    const w = mount(TutorialNavigator)
    await flushPromises()
    const btn = w.find('.joule-search-btn')
    expect(btn.exists()).toBe(true)
    // Empty query falls back to "tutorials".
    expect(btn.attributes('aria-label')).toBe('Ask Joule about tutorials')
  })

  it('opens Joule with no message when the query is empty', async () => {
    const w = mount(TutorialNavigator)
    await flushPromises()
    await w.find('.joule-search-btn').trigger('click')
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openWithMessageSpy).not.toHaveBeenCalled()
  })

  it('sends the canned template via openWithMessage when the query is non-empty', async () => {
    const w = mount(TutorialNavigator)
    await flushPromises()
    const input = w.find('input[type="text"].fd-input-group__input')
    await input.setValue('abap async')
    await w.find('.joule-search-btn').trigger('click')
    expect(openWithMessageSpy).toHaveBeenCalledTimes(1)
    const msg = openWithMessageSpy.mock.calls[0][0].text
    expect(msg).toContain('Find tutorials about: abap async')
    expect(msg).toContain('expandSearchConcepts')
    expect(msg).toContain('searchTutorials')
    // Empty-path opener not touched on the non-empty branch.
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('populates globalThis.__JOULE_NAV_SEARCH before calling openWithMessage', async () => {
    const w = mount(TutorialNavigator)
    await flushPromises()
    const input = w.find('input[type="text"].fd-input-group__input')
    await input.setValue('abap async')
    openWithMessageSpy.mockImplementation(() => {
      expect((globalThis as any).__JOULE_NAV_SEARCH).toBeDefined()
      expect((globalThis as any).__JOULE_NAV_SEARCH.queryLength).toBe('abap async'.length)
      expect(typeof (globalThis as any).__JOULE_NAV_SEARCH.ts).toBe('number')
      expect(typeof (globalThis as any).__JOULE_NAV_SEARCH.hasFilters).toBe('boolean')
    })
    await w.find('.joule-search-btn').trigger('click')
    expect(openWithMessageSpy).toHaveBeenCalled()
    // Also verify from outside the mock so the assertions above can't be
    // silently swallowed by a broken implementation.
    expect((globalThis as any).__JOULE_NAV_SEARCH.queryLength).toBe('abap async'.length)
  })

  it('is a no-op when window.joule is undefined', async () => {
    ;(window as any).joule = undefined
    const w = mount(TutorialNavigator)
    await flushPromises()
    const input = w.find('input[type="text"].fd-input-group__input')
    await input.setValue('abap async')
    // Must not throw.
    await w.find('.joule-search-btn').trigger('click')
  })
})
