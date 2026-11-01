// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Stub the realtime composable so mounting does not open a real socket.
vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'

const makePayload = (authenticated: boolean, allComplete: boolean) => ({
  eventId: 10000005,
  eventName: 'TechEd 2026',
  eventType: 'TECHED',
  authenticated,
  type: 'COMPLEX',
  paths: [{
    id: 1, title: 'Track A', description: '', items: [
      { imsId: 1, title: 'Tut 1', type: 'TUTORIAL', status: allComplete ? 'COMPLETED' : '', progress: allComplete ? 100 : 0, experience: '', timeToComplete: 0, url: '/tutorials/x.html', description: '' },
      { imsId: 99, title: 'Checkpoint', type: 'CHECKPOINT', status: '', progress: 0, experience: '', timeToComplete: 0, url: '', description: '' },
    ]
  }]
})

// Re-reads a mutable completion flag on every getAppSpaceProgress fetch so a
// Refresh can observe server state that changed between calls.
function stubFetchDynamic(getBody: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('getAppSpaceProgress')) {
      return { ok: true, status: 200, json: async () => getBody() }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch)
}

describe('AppSpace refresh button (#2952)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000005')
  })

  it('renders a Refresh button in the overview header', async () => {
    stubFetchDynamic(() => makePayload(true, false))
    const wrapper = mount(AppSpace)
    await flushPromises()

    const btn = wrapper.find('.section-header .refresh-button')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('Refresh')
  })

  it('re-fetches progress on click and reveals the barcode once the track completes', async () => {
    let complete = false
    stubFetchDynamic(() => makePayload(true, complete))

    const wrapper = mount(AppSpace)
    await flushPromises()

    // Enter the track detail view; checkpoint is locked, no barcode yet.
    await wrapper.find('.track-card').trigger('click')
    await flushPromises()
    expect(wrapper.find('.checkpoint-barcode__img').exists()).toBe(false)

    // Server-side completion lands; user hits Refresh.
    complete = true
    await wrapper.find('.detail-title-row .refresh-button').trigger('click')
    await flushPromises()

    const img = wrapper.find('.checkpoint-barcode__img')
    expect(img.exists()).toBe(true)
    // Barcode URL is cache-busted after a manual refresh.
    expect(img.attributes('src')).toMatch(/\/api\/my-prize-barcode\?eventId=10000005&_=\d+/)
  })

  it('keeps the user on the open track across a refresh', async () => {
    stubFetchDynamic(() => makePayload(true, false))
    const wrapper = mount(AppSpace)
    await flushPromises()

    await wrapper.find('.track-card').trigger('click')
    await flushPromises()
    expect(wrapper.find('.detail-title').text()).toBe('Track A')

    await wrapper.find('.detail-title-row .refresh-button').trigger('click')
    await flushPromises()

    // Still in the detail view for the same track, not bounced to the overview.
    expect(wrapper.find('.detail-title').exists()).toBe(true)
    expect(wrapper.find('.detail-title').text()).toBe('Track A')
  })
})
