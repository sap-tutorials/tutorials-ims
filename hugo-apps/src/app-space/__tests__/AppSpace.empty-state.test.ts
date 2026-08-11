// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// The realtime composable opens a socket.io connection; stub it so mounting the
// logged-in / has-tracks path doesn't attempt a real WebSocket in tests.
vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const { ok, status, body } = handler(String(input))
    return { ok, status, json: async () => body }
  }) as unknown as typeof fetch)
}

describe('AppSpace empty / not-configured state', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000004')
  })

  it('shows a "no tracks configured" state when the event has no mission (API 400)', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) {
        return { ok: false, status: 400, body: { error: { message: 'Event 10000004 has no mission configured' } } }
      }
      return { ok: false, status: 404, body: {} } // /app-space-data.json fallback
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.empty-state__desc').text()).toContain('mission')
    // No silent fallback to a track grid with zero cards.
    expect(wrapper.find('.track-grid').exists()).toBe(false)
  })

  it('renders the track grid when the event resolves to tracks', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) {
        return {
          ok: true, status: 200, body: {
            eventId: 10000004, eventName: 'Joule Agent Lab', eventType: 'OTHER', type: 'COMPLEX',
            paths: [{
              id: 1, title: 'Track A', description: '', items: [
                { imsId: 1, title: 'Tut 1', type: 'TUTORIAL', status: '', progress: 0, experience: '', timeToComplete: 0, url: '/tutorials/x.html', description: '' }
              ]
            }]
          }
        }
      }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(wrapper.find('.track-grid').exists()).toBe(true)
    expect(wrapper.text()).toContain('Track A')
  })
})
