// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Scene from '../Scene.vue'
import type { MountConfig, MyGameboard } from '../types'
const CFG: MountConfig = { apiMyGameboard: '', joinUrl: '', imgBase: '/images/devtoberfest', demoAvatar: 7 }
const board = (level: number, avatarIndex = 3): MyGameboard => ({ userId: 'u', score: 3500, level, avatarIndex, breakdown: [] })

describe('Scene.vue', () => {
  it('places the avatar on the cloud + bounce class matching level, with N hearts', () => {
    const w = mount(Scene, { props: { board: board(2), config: CFG, demo: false } })
    const av = w.find('.s-avatar')
    expect(av.classes()).toEqual(expect.arrayContaining(['cloud-2', 'avatar-2']))
    expect(av.attributes('src')).toBe('/images/devtoberfest/avatars/Group-3.png')
    expect(w.findAll('.s-heart')).toHaveLength(2)
  })
  it('shows the live score/level banner', () => {
    const w = mount(Scene, { props: { board: board(1), config: CFG, demo: false } })
    expect(w.find('.s-banner').text()).toContain('POINTS: 3500 LEVEL: 1')
  })
  it('renders the core sprite layers', () => {
    const w = mount(Scene, { props: { board: board(0), config: CFG, demo: false } })
    for (const cls of ['.s-frame', '.s-sky', '.s-lobster', '.s-runner', '.s-avatar']) {
      expect(w.find(cls).exists()).toBe(true)
    }
  })
})
