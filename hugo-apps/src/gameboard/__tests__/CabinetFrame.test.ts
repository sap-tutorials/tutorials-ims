// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CabinetFrame from '../CabinetFrame.vue'
import type { GameboardConfig } from '../types'

const BASE: GameboardConfig = {
  thresholds: [{ level: 0, minScore: 0 }, { level: 1, minScore: 3000 }, { level: 2, minScore: 14000 }],
  totals: [
    { week: '1', trackId: 't1', totalPoints: 3000, totalCount: 5 },
    { week: '1', trackId: 't2', totalPoints: 2000, totalCount: 4 },
    { week: '2', trackId: 't1', totalPoints: 1500, totalCount: 3 },
  ],
  tracks: [
    { trackId: 't1', title: 'ABAP' },
    { trackId: 't2', title: 'BTP' },
  ],
  hasActiveEvent: true,
  activityCount: 3,
  personalized: null,
}

const JOINED = {
  status: 'joined' as const,
  userId: 'u1', score: 3500, level: 1, avatarIndex: 3,
  breakdown: [
    { week: '1', trackId: 't1', earnedPoints: 3000, earnedCount: 3, remainingPoints: 0, remainingCount: 2 },
    { week: '2', trackId: 't1', earnedPoints: 500, earnedCount: 1, remainingPoints: 1000, remainingCount: 2 },
  ],
}

describe('CabinetFrame.vue', () => {
  it('joined participant → avatar (avatarIndex→art) + progress meters, no CTA', () => {
    const w = mount(CabinetFrame, { props: { board: { ...BASE, personalized: JOINED }, imgBase: '/images/devtoberfest', authState: 'authenticated' } })
    expect(w.find('.cabinet').exists()).toBe(true)
    const img = w.find('.cabinet-player img')
    expect(img.attributes('src')).toBe('/images/devtoberfest/avatars/Group-3.png')
    expect(img.attributes('alt')).toContain('level 1')
    const bars = w.findAll('[role="progressbar"]')
    expect(bars.length).toBeGreaterThanOrEqual(2)
    expect(w.text()).toContain('ABAP')      // labelled by track title, not GUID
    expect(w.text()).not.toContain('t1')
    expect(w.text()).toContain('Level 1')
    expect(w.find('.cabinet-cta').exists()).toBe(false)
  })

  it('ANONYMOUS (401) → "Log in" CTA, no avatar', () => {
    const w = mount(CabinetFrame, { props: { board: { ...BASE, personalized: null }, imgBase: '/images/devtoberfest', authState: 'anonymous' } })
    expect(w.find('.cabinet-player').exists()).toBe(false)
    expect(w.text().toLowerCase()).toContain('log in')
    expect(w.find('.cabinet-cta-login').exists()).toBe(true)
  })

  it('LOGGED-IN but NOT JOINED → "Join Devtoberfest" CTA (the bug: was telling logged-in users to log in)', () => {
    const w = mount(CabinetFrame, {
      props: { board: { ...BASE, personalized: { status: 'not_joined', userId: 'u2', score: 0, level: 0, avatarIndex: 5, breakdown: [] } }, imgBase: '/images/devtoberfest', authState: 'authenticated' },
    })
    expect(w.text()).toContain('Join Devtoberfest')
    expect(w.text().toLowerCase()).not.toContain('log in')
    const link = w.find('.cabinet-join-link')
    expect(link.attributes('href')).toBe('/devtoberfest/#join')
  })

  it('NO active event → "not running" CTA', () => {
    const w = mount(CabinetFrame, {
      props: { board: { ...BASE, hasActiveEvent: false, activityCount: 0, personalized: { status: 'no_event', userId: 'u3', score: 0, level: 0, avatarIndex: 0, breakdown: [] } }, imgBase: '/images/devtoberfest', authState: 'authenticated' },
    })
    expect(w.text().toLowerCase()).toContain("isn't running")
  })

  it('active event but NO activities → "coming soon" empty-state', () => {
    const w = mount(CabinetFrame, {
      props: { board: { ...BASE, hasActiveEvent: true, activityCount: 0, totals: [], personalized: { status: 'not_joined', userId: 'u4', score: 0, level: 0, avatarIndex: 0, breakdown: [] } }, imgBase: '/images/devtoberfest', authState: 'authenticated' },
    })
    expect(w.text().toLowerCase()).toContain('coming soon')
  })
})
