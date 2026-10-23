// @vitest-environment happy-dom
//
// #2864 — a temporarily-unavailable path item must render a "Temporarily
// Unavailable" badge on the App Space kiosk timeline, be greyed, and NOT be
// clickable (no window.open on click). The whole point of the feature: an
// admin flips the flag to pull a broken/maintenance item from the live kiosk.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    if (String(input).includes('getAppSpaceProgress')) return { ok: true, status: 200, json: async () => body }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch)
}

const feed = {
  eventId: 10000015, eventName: 'Joule Studio Lab', eventType: 'OTHER', type: 'COMPLEX',
  paths: [{
    id: 1, title: 'Track A', description: '', items: [
      {
        imsId: 1, title: 'Joule Studio (BDC)', type: 'TUTORIAL', status: 'AVAILABLE',
        progress: 0, experience: '', timeToComplete: 0, url: '/tutorials/joule-studio.html',
        description: '', temporarilyUnavailable: true, unavailableReason: 'Down for maintenance',
      },
    ],
  }],
}

describe('AppSpace — #2864 temporarily-unavailable item', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000015')
  })

  it('renders the badge, reason, greyed item, and does not open on click', async () => {
    stubFetch(feed)
    const openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)

    const wrapper = mount(AppSpace)
    await flushPromises()
    await wrapper.find('.track-card').trigger('click')
    await flushPromises()

    expect(wrapper.find('.item-unavailable__badge').text()).toBe('Temporarily Unavailable')
    expect(wrapper.find('.item-unavailable__reason').text()).toBe('Down for maintenance')
    expect(wrapper.find('.timeline-item--unavailable').exists()).toBe(true)

    // Title must NOT be clickable and clicking it must not open the tutorial.
    const title = wrapper.find('.timeline-content__title')
    expect(title.classes()).not.toContain('clickable')
    await title.trigger('click')
    expect(openSpy).not.toHaveBeenCalled()
  })
})
