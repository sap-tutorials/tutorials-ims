// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DevtoberfestHome from '../DevtoberfestHome.vue'

const CONFIG = {
  apiStatus: '/api/devtoberfest/status', apiTerms: '/api/devtoberfest/terms',
  apiJoin: '/api/devtoberfest/join', apiMe: '/api/devtoberfest/me',
  imgKasimir: '/k.svg', imgTeched: '/t.svg', imgDevtoberfest: '/d.svg',
}

function stubStatusJoined() {
  const body = {
    event: { name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' },
    joined: true, termsVersion: 1, termsRequired: false,
    contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  })) as unknown as typeof fetch)
}

describe('DevtoberfestHome promo video (#2144)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('embeds the promo video with muted autoplay on the registered state', async () => {
    stubStatusJoined()
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    const iframe = wrapper.find('.dtf-promo-embed')
    expect(iframe.exists()).toBe(true)
    const src = iframe.attributes('src') || ''
    expect(src).toContain('www.youtube.com/embed/ZvxLbaMg2Gw')
    expect(src).not.toContain('youtube-nocookie.com')
    expect(src).toContain('autoplay=1')
    expect(src).toContain('mute=1')
    expect(iframe.attributes('allowfullscreen')).toBeDefined()
  })
})
