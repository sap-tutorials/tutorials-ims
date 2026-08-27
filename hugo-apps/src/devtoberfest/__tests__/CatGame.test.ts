// @vitest-environment happy-dom
//
// #2042 — the "Hit the Cat" mini-game. Points are awarded SERVER-SIDE; the
// client only relays the reason the award endpoint returns. These tests mock
// the csrfFetch POST and the /auth/user probe and assert the feedback the
// component surfaces for each reason plus the anonymous path.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CatGame from '../CatGame.vue'
import { csrfFetch } from '@shared/csrf-fetch'

// Mock the shared csrf POST helper — the award call routes through it.
vi.mock('@shared/csrf-fetch', () => ({
  csrfFetch: vi.fn(),
}))

const AWARD_URL = '/devtoberfest-api/cat-game/award'
const PROPS = { awardUrl: AWARD_URL, imgCatGame: '/images/devtoberfest/kasimir-types.png' }

// /auth/user probe: JSON body with a truthy (or falsy) `authenticated` flag.
function authProbe(authenticated: boolean) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ authenticated }),
  }
}

function stubAuth(authenticated: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/auth/user') return authProbe(authenticated)
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch)
}

// Award endpoint 200 JSON responses.
function awardRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function mountLoggedIn(awardBody: unknown) {
  stubAuth(true)
  ;(csrfFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(awardRes(awardBody))
  const wrapper = mount(CatGame, { props: PROPS })
  await flushPromises() // resolve probeAuth
  await wrapper.find('button.dtf-catgame-cat').trigger('click')
  await flushPromises() // resolve award POST
  return wrapper
}

describe('CatGame (#2042) — award feedback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ;(csrfFetch as unknown as ReturnType<typeof vi.fn>).mockReset()
  })

  it('awarded: shows "+5 points! …/… — come back tomorrow" and the score readout', async () => {
    const wrapper = await mountLoggedIn({ awarded: true, points: 5, total: 45, cap: 100, reason: 'awarded' })
    expect(csrfFetch).toHaveBeenCalledWith(AWARD_URL, expect.objectContaining({ method: 'POST' }))
    const fb = wrapper.find('.dtf-catgame-feedback').text()
    expect(fb).toContain('+5 points!')
    expect(fb).toContain('45/100')
    expect(fb).toContain('come back tomorrow')
    // Score HUD visible only when logged in.
    expect(wrapper.find('.dtf-catgame-score').text()).toContain('45 / 100')
  })

  it('already-today: shows "Already earned today — …/…"', async () => {
    const wrapper = await mountLoggedIn({ awarded: false, reason: 'already-today', total: 45, cap: 100 })
    const fb = wrapper.find('.dtf-catgame-feedback').text()
    expect(fb).toContain('Already earned today')
    expect(fb).toContain('45/100')
  })

  it('max: shows "Maxed out! …/…"', async () => {
    const wrapper = await mountLoggedIn({ awarded: false, reason: 'max', total: 100, cap: 100 })
    const fb = wrapper.find('.dtf-catgame-feedback').text()
    expect(fb).toContain('Maxed out!')
    expect(fb).toContain('100/100')
    expect(wrapper.find('.dtf-catgame-badge').text()).toContain('MAX')
  })

  it('inactive: shows the "not running right now" note', async () => {
    const wrapper = await mountLoggedIn({ awarded: false, reason: 'inactive' })
    expect(wrapper.find('.dtf-catgame-feedback').text()).toContain("isn't running right now")
  })

  it('anonymous: nudges to log in and never calls the award endpoint', async () => {
    stubAuth(false)
    const wrapper = mount(CatGame, { props: PROPS })
    await flushPromises() // resolve probeAuth (authenticated: false)
    await wrapper.find('button.dtf-catgame-cat').trigger('click')
    await flushPromises()
    expect(csrfFetch).not.toHaveBeenCalled()
    expect(wrapper.find('.dtf-catgame-feedback').text()).toContain('Log in during Devtoberfest')
    // No score HUD for anonymous visitors.
    expect(wrapper.find('.dtf-catgame-score').exists()).toBe(false)
  })
})
