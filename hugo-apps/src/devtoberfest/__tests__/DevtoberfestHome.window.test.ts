// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DevtoberfestHome from '../DevtoberfestHome.vue'

const CONFIG = {
  apiStatus: '/api/devtoberfest/status', apiTerms: '/api/devtoberfest/terms',
  apiJoin: '/api/devtoberfest/join', apiMe: '/api/devtoberfest/me',
  imgKasimir: '/k.svg', imgTeched: '/t.svg', imgDevtoberfest: '/d.svg',
}

const START = '2026-09-21T00:00:00Z'
const END = '2026-10-18T23:59:59Z'

function stubStatus(extra: Record<string, unknown> = {}) {
  const body = {
    event: { name: 'Devtoberfest', startDate: START, endDate: END },
    joined: true, termsVersion: 1, termsRequired: false,
    contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
    ...extra,
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  })) as unknown as typeof fetch)
}

describe('DevtoberfestHome contest window (#1725)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the exact start/end with datetime attributes carrying the ISO instants', async () => {
    stubStatus()
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()

    const win = wrapper.find('.dtf-window')
    expect(win.exists()).toBe(true)

    const times = win.findAll('time')
    expect(times).toHaveLength(2)
    expect(times[0].attributes('datetime')).toBe(START)
    expect(times[1].attributes('datetime')).toBe(END)
    // Visible label carries a real, non-empty local date/time string.
    expect(times[0].text().length).toBeGreaterThan(0)
    expect(times[1].text().length).toBeGreaterThan(0)
  })

  it('renders a live countdown line with a recognizable phase label', async () => {
    stubStatus()
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()

    const cd = wrapper.find('.dtf-window-countdown')
    expect(cd.exists()).toBe(true)
    // Clock-independent: whichever phase we're in, the label is one of these.
    expect(cd.text()).toMatch(/Starts in|Ends in|has ended/)
    expect(['before', 'during', 'ended']).toContain(cd.attributes('data-phase'))
  })

  it('exposes an accessible tooltip explaining the technical times and linking to the Terms', async () => {
    stubStatus()
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()

    const info = wrapper.find('.dtf-window-info')
    expect(info.exists()).toBe(true)

    // Button points at the tooltip it describes.
    const tipId = info.attributes('aria-describedby')
    expect(tipId).toBe('dtf-window-tip')

    const tip = wrapper.find(`#${tipId}`)
    expect(tip.exists()).toBe(true)
    expect(tip.attributes('role')).toBe('tooltip')
    expect(tip.text().toLowerCase()).toContain('technical')
    expect(tip.text().toLowerCase()).toContain('points during this window')

    const link = tip.find('a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/devtoberfest/rules/')
    expect(link.text()).toContain('Legal Terms')
  })

  it('still shows the contest window when a banner image is present', async () => {
    stubStatus({ bannerUrl: '/api/devtoberfest/banner' })
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()

    expect(wrapper.find('img.dtf-banner-img').exists()).toBe(true)
    expect(wrapper.find('.dtf-window').exists()).toBe(true)
  })

  it('omits the window entirely when the event has no dates', async () => {
    stubStatus({ event: { name: 'Devtoberfest', startDate: '', endDate: '' } })
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()

    expect(wrapper.find('.dtf-window').exists()).toBe(false)
  })
})
