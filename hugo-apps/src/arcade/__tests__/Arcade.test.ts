// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Arcade from '../Arcade.vue'
import type { MountConfig } from '../types'

const CFG: MountConfig = { apiMyGameboard: '/gameboard/getMyGameboard', joinUrl: '/devtoberfest/#join', imgBase: '/images/devtoberfest', demoAvatar: 7 }

function mockFetch(res: { ok: boolean; status: number; body?: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: res.ok, status: res.status, json: async () => res.body ?? {} }) as any
}

describe('Arcade.vue — status-driven CTA', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('renders the player scene when status is joined', async () => {
    mockFetch({ ok: true, status: 200, body: { status: 'joined', userId: 'u1', score: 3500, level: 1, avatarIndex: 3, breakdown: [] } })
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.authState).toBe('authenticated')
    expect(w.vm.cta.kind).toBe('none')
    expect(w.vm.board.level).toBe(1)
    expect(w.vm.board.avatarIndex).toBe(3)
    expect(w.find('.scene').exists()).toBe(true)
  })

  it('shows the Log in CTA on 401 (anonymous)', async () => {
    mockFetch({ ok: false, status: 401 })
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.authState).toBe('anonymous')
    expect(w.vm.cta.kind).toBe('login')
    expect(w.html()).toContain('Log in')
  })

  it('shows the Join Devtoberfest CTA when authenticated + not_joined', async () => {
    mockFetch({ ok: true, status: 200, body: { status: 'not_joined', userId: 'u1', score: 0, level: 0, avatarIndex: 7, breakdown: [] } })
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.authState).toBe('authenticated')
    expect(w.vm.cta.kind).toBe('join')
    const link = w.find('.arcade-cta-btn')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/devtoberfest/#join')
    expect(w.html()).toContain('Join Devtoberfest')
  })

  it("shows the no-event CTA when status is no_event", async () => {
    mockFetch({ ok: true, status: 200, body: { status: 'no_event', userId: 'u1', score: 0, level: 0, avatarIndex: 7, breakdown: [] } })
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.cta.kind).toBe('no_event')
    expect(w.html()).toContain("isn't running right now")
  })

  it('shows the coming-soon empty-state when active event but zero activities', async () => {
    mockFetch({ ok: true, status: 200, body: { status: 'not_joined', userId: 'u1', score: 0, level: 0, avatarIndex: 7, hasActiveEvent: true, activityCount: 0, breakdown: [] } })
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.cta.kind).toBe('coming_soon')
    expect(w.html()).toContain('coming soon')
  })

  it('falls back to the Log in CTA on network error (fail-soft, never throws)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.authState).toBe('anonymous')
    expect(w.vm.cta.kind).toBe('login')
  })
})
