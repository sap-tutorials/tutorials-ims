// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Regression: the `eventId` URL query param must be read case-insensitively.
// Users were hitting /app-space/?eventid=... (lowercase) and getting the
// default event because URLSearchParams.get('eventId') is case-sensitive.

vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'

const eventBody = {
  eventId: 10000015,
  eventName: 'Case Insensitive Event',
  eventDescription: '<p>ok</p>',
  eventType: 'DEVTOBERFEST',
  authenticated: false,
  type: 'COMPLEX',
  paths: [{
    id: 1, title: 'Track A', description: '', items: [
      { imsId: 1, title: 'Tut 1', type: 'TUTORIAL', status: '', progress: 0, experience: '', timeToComplete: 0, url: '/tutorials/x.html', description: '' }
    ]
  }]
}

describe('AppSpace eventId query param is case-insensitive', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  for (const key of ['eventId', 'eventid', 'EVENTID', 'EventId']) {
    it(`reads the event id from ?${key}=10000015`, async () => {
      window.history.replaceState({}, '', `/app-space/?${key}=10000015`)
      const fetchSpy = vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, json: async () => eventBody }
        return { ok: false, status: 404, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

      mount(AppSpace)
      await flushPromises()

      // The backend call must carry the id read from the URL, not the default 0.
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes('eventLegacyId=10000015'))).toBe(true)
      expect(urls.some((u) => u.includes('eventLegacyId=0'))).toBe(false)
    })
  }
})
