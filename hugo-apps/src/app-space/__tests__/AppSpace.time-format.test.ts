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

// timeToComplete is sourced from Tutorials.averageTimeToComplete, which is stored
// in MINUTES (frontmatter `time`). The badge must render it as minutes directly —
// the old formatTime divided by 60 and turned a 15-min tutorial into "0 min".
function eventWithTrackTimes(minutes: number[]) {
  return {
    eventId: 10000004, eventName: 'Joule Agent Lab', eventType: 'OTHER', type: 'COMPLEX',
    paths: [{
      id: 1, title: 'Track A', description: '',
      items: minutes.map((m, i) => ({
        imsId: i + 1, title: `Tut ${i + 1}`, type: 'TUTORIAL', status: '',
        progress: 0, experience: '', timeToComplete: m, url: `/tutorials/t${i}.html`, description: ''
      }))
    }]
  }
}

describe('AppSpace time badge formatting (minutes, not seconds)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000004')
  })

  it('renders a 15-minute tutorial as "15 min" (not "0 min")', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: eventWithTrackTimes([15]) }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    const time = wrapper.find('.track-card__time').text()
    expect(time).toBe('15 min')
    expect(time).not.toContain('0 min')
  })

  it('sums track minutes and rolls over to hours (45 + 45 = "1 hr 30 min")', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: eventWithTrackTimes([45, 45]) }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    expect(wrapper.find('.track-card__time').text()).toBe('1 hr 30 min')
  })
})
