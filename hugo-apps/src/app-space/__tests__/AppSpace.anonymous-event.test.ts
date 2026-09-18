// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// #2314 regression coverage: an anonymous visitor opening app-space with an
// eventId in the URL must see the CORRECT event (the endpoint is now
// anonymous-readable), and the default event name must NOT flash before the
// URL event resolves.

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

const anonEventBody = {
  eventId: 66303,
  eventName: 'Devtoberfest 2026',
  eventDescription: '<p>Anonymous can see this.</p>',
  eventType: 'DEVTOBERFEST',
  authenticated: false,
  type: 'COMPLEX',
  paths: [{
    id: 1, title: 'Track A', description: '', items: [
      { imsId: 1, title: 'Tut 1', type: 'TUTORIAL', status: '', progress: 0, experience: '', timeToComplete: 0, url: '/tutorials/x.html', description: '' }
    ]
  }]
}

describe('AppSpace anonymous event resolution (#2314)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=66303')
  })

  it('renders the correct event name for an anonymous visitor (authenticated:false, 200)', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: anonEventBody }
      return { ok: false, status: 404, body: {} } // static fallback must NOT be reached
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    expect(wrapper.find('.hero-title').text()).toBe('Devtoberfest 2026')
    // Never the default event that used to show when the API 401'd for anon.
    expect(wrapper.text()).not.toContain('SAP TechEd')
    expect(wrapper.find('.track-grid').exists()).toBe(true)
  })

  it('does not flash the default event name before the URL event resolves', async () => {
    let resolveApi: (v: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      if (String(input).includes('getAppSpaceProgress')) {
        // Keep the request pending so we can inspect the loading state.
        return new Promise((resolve) => {
          resolveApi = () => resolve({ ok: true, status: 200, json: async () => anonEventBody })
        })
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    }) as unknown as typeof fetch)

    const wrapper = mount(AppSpace)
    await flushPromises() // onMounted has run; API still pending → loading state

    // While loading: skeleton shown, no default title flashed.
    expect(wrapper.find('.hero-title-skeleton').exists()).toBe(true)
    expect(wrapper.find('.hero-title').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('SAP TechEd')

    resolveApi(null)
    await flushPromises()

    // After load: real event name, skeleton gone.
    expect(wrapper.find('.hero-title-skeleton').exists()).toBe(false)
    expect(wrapper.find('.hero-title').text()).toBe('Devtoberfest 2026')
  })
})
