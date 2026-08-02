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
    // Intentionally empty URL fields — rail must NOT depend on them.
    contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  })) as unknown as typeof fetch)
}

describe('DevtoberfestHome rail', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders exactly 7 fixed internal rail links regardless of status URLs', async () => {
    stubStatusJoined()
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    const links = wrapper.findAll('.dtf-rail-item')
    expect(links).toHaveLength(7)
    const pairs = links.map((a) => [a.text().trim(), a.attributes('href')])
    expect(pairs).toEqual([
      ['THE WEEKS', '/devtoberfest/calendar/'],
      ['ACTIVITIES', '/devtoberfest/schedule/'],
      ['SESSIONS', '/devtoberfest/sessions/'],
      ['ARCADE', '/devtoberfest/arcade/'],
      ['LEADERBOARD', '/devtoberfest/gameboard/'],
      ['THE RULES', '/devtoberfest/rules/'],
      ['FAQ', '/devtoberfest/faq/'],
    ])
  })
})
