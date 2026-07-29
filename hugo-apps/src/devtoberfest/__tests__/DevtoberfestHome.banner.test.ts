// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DevtoberfestHome from '../DevtoberfestHome.vue'

const CONFIG = {
  apiStatus: '/api/devtoberfest/status', apiTerms: '/api/devtoberfest/terms',
  apiJoin: '/api/devtoberfest/join', apiMe: '/api/devtoberfest/me',
  imgKasimir: '/k.svg', imgTeched: '/t.svg', imgDevtoberfest: '/d.svg',
}

function stubStatus(extra: Record<string, unknown>) {
  const body = {
    event: { name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' },
    joined: true, termsVersion: 1, termsRequired: false,
    contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
    ...extra,
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  })) as unknown as typeof fetch)
}

describe('DevtoberfestHome banner', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the banner image when bannerUrl is set', async () => {
    stubStatus({ bannerUrl: '/api/devtoberfest/banner' })
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    const img = wrapper.find('img.dtf-banner-img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/api/devtoberfest/banner')
    // Gradient brand text/logos suppressed when banner present
    expect(wrapper.find('.dtf-brand-title').exists()).toBe(false)
  })

  it('falls back to the gradient header when bannerUrl is empty', async () => {
    stubStatus({ bannerUrl: '' })
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('img.dtf-banner-img').exists()).toBe(false)
    expect(wrapper.find('.dtf-brand-title').text()).toContain('Devtoberfest')
  })
})
