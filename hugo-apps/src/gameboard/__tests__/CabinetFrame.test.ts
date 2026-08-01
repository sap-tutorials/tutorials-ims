// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CabinetFrame from '../CabinetFrame.vue'
import type { GameboardConfig } from '../types'

const BOARD: GameboardConfig = {
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
  personalized: {
    userId: 'u1', score: 3500, level: 1, avatarIndex: 3,
    breakdown: [
      { week: '1', trackId: 't1', earnedPoints: 3000, earnedCount: 3, remainingPoints: 0, remainingCount: 2 },
      { week: '2', trackId: 't1', earnedPoints: 500, earnedCount: 1, remainingPoints: 1000, remainingCount: 2 },
    ],
  },
}

describe('CabinetFrame.vue', () => {
  it('confines arcade styling to a .cabinet region and maps avatarIndex→art file', () => {
    const w = mount(CabinetFrame, { props: { board: BOARD, imgBase: '/images/devtoberfest' } })
    expect(w.find('.cabinet').exists()).toBe(true)
    // avatarIndex 3 → Group-3.png under imgBase (static asset, not an inline SVG string)
    const img = w.find('.cabinet img')
    expect(img.attributes('src')).toBe('/images/devtoberfest/avatars/Group-3.png')
    // alt text uses the personalized level
    expect(img.attributes('alt')).toContain('level 1')
    // per-week progress rendered as accessible meters (progressbar role), not baked images.
    // BOARD has weeks '1' and '2' → at least two week meters.
    const bars = w.findAll('[role="progressbar"]')
    expect(bars.length).toBeGreaterThanOrEqual(2)
    expect(bars[0].attributes('aria-valuenow')).toBeDefined()
    // meters are labelled by the resolved track TITLE, not the trackId GUID
    expect(w.text()).toContain('ABAP')
    expect(w.text()).not.toContain('t1')
    expect(w.text()).toContain('Level 1')
  })

  it('renders a public (no-personalized) cabinet without throwing', () => {
    const w = mount(CabinetFrame, { props: { board: { ...BOARD, personalized: null }, imgBase: '/images/devtoberfest' } })
    expect(w.find('.cabinet').exists()).toBe(true)
    expect(w.text().toLowerCase()).toContain('log in') // invite to sign in for a personal slice
  })
})
