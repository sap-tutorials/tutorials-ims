// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Scene from '../Scene.vue'
import type { MountConfig, MyGameboard } from '../types'
import { RULES_URL, JOIN_GROUP_URL, COMMUNITY_PROFILE_BASE } from '../scene-text'
const CFG: MountConfig = { apiMyGameboard: '', joinUrl: '', imgBase: '/images/devtoberfest', demoAvatar: 7 }
const board = (level: number, avatarIndex = 3, extra: Partial<MyGameboard> = {}): MyGameboard =>
  ({ userId: 'u', score: 3500, level, avatarIndex, breakdown: [], ...extra })

describe('Scene.vue — sprites + banner', () => {
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
  it('labels level 4 as Nerdvana in the banner', () => {
    const w = mount(Scene, { props: { board: board(4), config: CFG, demo: false } })
    expect(w.find('.s-banner').text()).toContain('LEVEL: Nerdvana')
  })
  it('renders the core sprite layers', () => {
    const w = mount(Scene, { props: { board: board(0), config: CFG, demo: false } })
    for (const cls of ['.s-frame', '.s-sky', '.s-lobster', '.s-runner', '.s-avatar']) {
      expect(w.find(cls).exists()).toBe(true)
    }
  })
})

describe('Scene.vue — legacy instructional content', () => {
  it('renders the HOW TO PLAY column with join + rules links', () => {
    const w = mount(Scene, { props: { board: board(1), config: CFG, demo: false } })
    const col = w.find('.s-howto')
    expect(col.exists()).toBe(true)
    expect(col.text()).toContain('HOW TO PLAY')
    const links = col.findAll('a')
    const hrefs = links.map((a) => a.attributes('href'))
    expect(hrefs).toContain(JOIN_GROUP_URL)
    expect(hrefs).toContain(RULES_URL)
  })

  it('renders the MAKING THE LAWYERS HAPPY column with a rules link', () => {
    const w = mount(Scene, { props: { board: board(1), config: CFG, demo: false } })
    const col = w.find('.s-lawyers')
    expect(col.exists()).toBe(true)
    expect(col.text()).toContain('MAKING THE LAWYERS HAPPY')
    expect(col.text()).toContain('entertainment purposes only')
    expect(col.findAll('a').some((a) => a.attributes('href') === RULES_URL)).toBe(true)
  })

  it('renders the 3 rules-link menu items opening in a new tab', () => {
    const w = mount(Scene, { props: { board: board(1), config: CFG, demo: false } })
    const items = w.findAll('.s-menu a')
    expect(items).toHaveLength(3)
    for (const a of items) {
      expect(a.attributes('href')).toBe(RULES_URL)
      expect(a.attributes('target')).toBe('_blank')
    }
    const labels = items.map((a) => a.text())
    expect(labels).toEqual(expect.arrayContaining(['AWARDS', 'POINTS', 'RULES']))
  })

  it('shows the greeting header with the dynamic event edition (not a hardcoded year)', () => {
    const w = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom', eventName: 'Devtoberfest 2026' }), config: CFG, demo: false } })
    expect(w.find('.s-header').text()).toContain('Tom, Devtoberfest 2026 has started!')
  })

  it('falls back to a year-less greeting when no event name is available', () => {
    const w = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom' }), config: CFG, demo: false } })
    const text = w.find('.s-header').text()
    expect(text).toContain('Tom, Devtoberfest has started!')
    expect(text).not.toContain('2025')
  })

  it("says 'has started!' when the event phase is running", () => {
    const w = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom', eventName: 'Devtoberfest 2026', eventPhase: 'running' }), config: CFG, demo: false } })
    expect(w.find('.s-header').text()).toContain('Tom, Devtoberfest 2026 has started!')
  })

  it("says 'starts <date>!' before the event has begun (upcoming, #1439)", () => {
    const w = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom', eventName: 'Devtoberfest 2026', eventPhase: 'upcoming', eventStart: '2026-10-06T00:00:00Z' }), config: CFG, demo: false } })
    const text = w.find('.s-header').text()
    expect(text).toContain('Tom, Devtoberfest 2026 starts Oct 6!')
    expect(text).not.toContain('has started!')
  })

  it("says 'is coming soon!' when upcoming with no known start date", () => {
    const w = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom', eventName: 'Devtoberfest 2026', eventPhase: 'upcoming' }), config: CFG, demo: false } })
    const text = w.find('.s-header').text()
    expect(text).toContain('Tom, Devtoberfest 2026 is coming soon!')
    expect(text).not.toContain('has started!')
  })

  it("says 'has ended.' after the event window closes", () => {
    const w = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom', eventName: 'Devtoberfest 2026', eventPhase: 'ended' }), config: CFG, demo: false } })
    const text = w.find('.s-header').text()
    expect(text).toContain('Tom, Devtoberfest 2026 has ended.')
    expect(text).not.toContain('has started!')
  })

  it('links the SAP Community profile only when community-linked', () => {
    const linked = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom', communityUrl: `${COMMUNITY_PROFILE_BASE}42` }), config: CFG, demo: false } })
    expect(linked.find('.s-header a').exists()).toBe(true)
    expect(linked.find('.s-header a').attributes('href')).toBe(`${COMMUNITY_PROFILE_BASE}42`)

    const generic = mount(Scene, { props: { board: board(1, 3, { firstName: 'Tom' }), config: CFG, demo: false } })
    expect(generic.find('.s-header a').exists()).toBe(false)
  })
})
