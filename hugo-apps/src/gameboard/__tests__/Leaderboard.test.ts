// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Leaderboard from '../Leaderboard.vue'
import type { LeaderboardRow } from '../types'

const ROWS: LeaderboardRow[] = [
  { rank: 1, displayName: 'Tom J. (community)', score: 300, level: 3, communityUrl: 'https://community.sap.com/u/1' },
  { rank: 2, displayName: 'Ann K.', score: 150, level: 2, communityUrl: null },
]

describe('Leaderboard.vue', () => {
  it('renders a captioned accessible table with a community link and score bars scaled to the leader', () => {
    const w = mount(Leaderboard, { props: { rows: ROWS } })
    expect(w.find('table caption').exists()).toBe(true)
    expect(w.findAll('th[scope="col"]').length).toBeGreaterThanOrEqual(4)
    expect(w.findAll('tbody tr').length).toBe(2)
    const link = w.find('tbody tr:first-child a')
    expect(link.attributes('href')).toBe('https://community.sap.com/u/1')
    expect(link.attributes('rel')).toContain('noopener')
    // score bar width is proportional to the top score (300 → 100%)
    const topBar = w.find('tbody tr:first-child [data-testid="score-bar"]')
    expect(topBar.attributes('style') || '').toContain('100%')
  })

  it('shows an empty state when there are no rows', () => {
    const w = mount(Leaderboard, { props: { rows: [] } })
    expect(w.text().toLowerCase()).toContain('no scores yet')
  })
})
