// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Regression (#app-space-track-url): selecting a track must be reflected in a
// `?track=<id>` query param so a page refresh restores the detail view and the
// browser back/forward buttons move between the list and a track. Previously
// selectTrack/goBack only mutated local state, so refresh reset to the list and
// history navigation did nothing.

vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'

const eventBody = {
  eventId: 10000002,
  eventName: 'Track URL Event',
  eventDescription: '<p>ok</p>',
  eventType: 'DEVTOBERFEST',
  authenticated: false,
  type: 'COMPLEX',
  paths: [
    { id: 11, title: 'Track A', description: '', items: [
      { imsId: 1, title: 'Tut 1', type: 'TUTORIAL', status: '', progress: 0, experience: '', timeToComplete: 0, url: '/tutorials/x.html', description: '' }
    ] },
    { id: 22, title: 'Track B', description: '', items: [
      { imsId: 2, title: 'Tut 2', type: 'TUTORIAL', status: '', progress: 0, experience: '', timeToComplete: 0, url: '/tutorials/y.html', description: '' }
    ] },
  ],
}

function stubFetch() {
  const fetchSpy = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, json: async () => eventBody }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
  return fetchSpy
}

describe('AppSpace track ↔ URL sync', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000002')
  })

  it('restores the selected track from ?track=<id> on load, preserving other params', async () => {
    window.history.replaceState({}, '', '/app-space/?eventId=10000002&track=22')
    stubFetch()

    const wrapper = mount(AppSpace)
    await flushPromises()

    // Detail view for Track B is shown (the `.detail-title` element only renders
    // in the track-detail branch), not the track list.
    expect(wrapper.find('.detail-title').exists()).toBe(true)
    expect(wrapper.find('.detail-title').text()).toBe('Track B')
    expect(wrapper.find('.track-grid').exists()).toBe(false)
  })

  it('adds ?track=<id> when a track is selected and keeps eventId', async () => {
    stubFetch()
    const wrapper = mount(AppSpace)
    await flushPromises()

    const vm = wrapper.vm as unknown as { selectTrack: (t: { id: number }) => void; tracks: { id: number }[] }
    vm.selectTrack(vm.tracks.find(t => t.id === 11)!)
    await flushPromises()

    const params = new URLSearchParams(window.location.search)
    expect(params.get('track')).toBe('11')
    expect(params.get('eventId')).toBe('10000002')
  })

  it('removes ?track on goBack', async () => {
    window.history.replaceState({}, '', '/app-space/?eventId=10000002&track=11')
    stubFetch()
    const wrapper = mount(AppSpace)
    await flushPromises()

    const vm = wrapper.vm as unknown as { goBack: () => void }
    vm.goBack()
    await flushPromises()

    const params = new URLSearchParams(window.location.search)
    expect(params.get('track')).toBeNull()
    expect(params.get('eventId')).toBe('10000002')
  })

  it('syncs state on popstate (back/forward)', async () => {
    stubFetch()
    const wrapper = mount(AppSpace)
    await flushPromises()

    const vm = wrapper.vm as unknown as { selectTrack: (t: { id: number }) => void; tracks: { id: number }[] }
    vm.selectTrack(vm.tracks.find(t => t.id === 22)!)
    await flushPromises()
    expect(wrapper.find('.detail-title').text()).toBe('Track B')

    // Simulate the back button: URL returns to the list, popstate fires.
    window.history.replaceState({}, '', '/app-space/?eventId=10000002')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(wrapper.find('.detail-title').exists()).toBe(false)
    expect(wrapper.find('.track-grid').exists()).toBe(true)
  })

  it('falls back to the list for an unknown track id', async () => {
    window.history.replaceState({}, '', '/app-space/?eventId=10000002&track=999')
    stubFetch()
    const wrapper = mount(AppSpace)
    await flushPromises()

    // Unknown id → list view (track grid), no crash, no detail.
    expect(wrapper.find('.track-grid').exists()).toBe(true)
    expect(wrapper.find('.detail-title').exists()).toBe(false)
  })
})
