// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'

// eventDescription arrives from the server already rendered to safe HTML
// (srv/lib/markdown.js, html:false). The client drops it in via v-html — this
// test guards that wiring (a regression to {{ }} would escape the tags).
function stubFetch(eventDescription: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('getAppSpaceProgress')) {
      return {
        ok: true, status: 200, json: async () => ({
          eventId: 10000004, eventName: 'Joule Agent Lab', eventType: 'OTHER', type: 'COMPLEX',
          eventDescription,
          paths: [{ id: 1, title: 'Track A', description: '', items: [] }]
        })
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch)
}

describe('AppSpace event description Markdown → HTML (#2296)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000004')
  })

  it('renders server-supplied description HTML via v-html (not escaped text)', async () => {
    stubFetch('<p><strong>Bold</strong> and <a href="https://example.com">a link</a></p>')
    const wrapper = mount(AppSpace)
    await flushPromises()

    const desc = wrapper.find('.hero-desc')
    expect(desc.exists()).toBe(true)
    expect(desc.html()).toContain('<strong>Bold</strong>')
    expect(desc.html()).toContain('href="https://example.com"')
    // The tags render as markup, so their literal source must NOT be visible text.
    expect(desc.text()).not.toContain('<strong>')
  })
})
