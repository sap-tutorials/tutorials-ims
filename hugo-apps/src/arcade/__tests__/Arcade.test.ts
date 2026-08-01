// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Arcade from '../Arcade.vue'
import type { MountConfig } from '../types'

const CFG: MountConfig = { apiMyGameboard: '/gameboard/getMyGameboard', joinUrl: '/devtoberfest/#join', imgBase: '/images/devtoberfest', demoAvatar: 7 }

describe('Arcade.vue', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('renders the player scene when getMyGameboard returns data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ userId: 'u1', score: 3500, level: 1, avatarIndex: 3, breakdown: [] }) }) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.state).toBe('player')
    expect(w.vm.board.level).toBe(1)
    expect(w.vm.board.avatarIndex).toBe(3)
  })

  it('falls to demo+CTA on 401 (anonymous)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.state).toBe('demo')
    expect(w.html()).toContain('Join Devtoberfest')
  })

  it('falls to demo on network error (fail-soft, never throws)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as any
    const w = mount(Arcade, { props: { config: CFG } })
    await flushPromises()
    expect(w.vm.state).toBe('demo')
  })
})
