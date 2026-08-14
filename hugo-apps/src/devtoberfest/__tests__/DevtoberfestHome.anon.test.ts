// @vitest-environment happy-dom
//
// #1788 — anonymous visitors must be detected as `anonymous`, not
// `unregistered`. The approuter serves an anonymous `/me` probe a 200
// login-redirect HTML page (not a clean 401) in some edge cases; `fetchStatus`
// must treat a non-JSON 200 as anonymous so it never opens the Terms dialog
// (which would make csrfFetch throw at the /auth/user token handshake).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DevtoberfestHome from '../DevtoberfestHome.vue'

const CONFIG = {
  apiStatus: '/api/devtoberfest/status', apiTerms: '/api/devtoberfest/terms',
  apiJoin: '/api/devtoberfest/join', apiMe: '/api/devtoberfest/me',
  imgKasimir: '/k.svg', imgTeched: '/t.svg', imgDevtoberfest: '/d.svg',
}

const STATUS_BODY = {
  event: { name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' },
  joined: false, termsRequired: true,
  contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
}

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  }
}

// Simulates the approuter's anonymous login-redirect: HTTP 200 with an HTML
// body (no JSON, no x-csrf-token) instead of the backend's real 401.
function htmlLoginRedirectRes() {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
  }
}

function stubFetch(meRes: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === CONFIG.apiStatus) return jsonRes(STATUS_BODY)
    if (url === CONFIG.apiMe) return meRes()
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch)
}

describe('DevtoberfestHome anonymous detection (#1788)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('a 200 HTML login-redirect /me response is treated as anonymous, not unregistered', async () => {
    stubFetch(htmlLoginRedirectRes)
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.attributes('data-state')).toBe('anonymous')
    // The unregistered-only "Join the Fest" body CTA must not render → dialog
    // (and therefore csrfFetch) is never reached.
    expect(wrapper.find('.dtf-cta-body-wrap').exists()).toBe(false)
  })

  it('a clean 401 /me response is treated as anonymous', async () => {
    stubFetch(() => jsonRes({ error: 'UNAUTHENTICATED' }, 401))
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.attributes('data-state')).toBe('anonymous')
  })

  it('a real JSON 200 (logged-in, not joined) stays unregistered', async () => {
    stubFetch(() => jsonRes({ joined: false }))
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.attributes('data-state')).toBe('unregistered')
  })
})
