// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Gameboard from '../Gameboard.vue'
import type { MountConfig } from '../types'

const CONFIG: MountConfig = {
  apiLeaderboard: '/gameboard/getLeaderboard',
  apiGameboard: '/gameboard/getGameboard',
  apiMyGameboard: '/gameboard/getMyGameboard',
  ws: '', imgBase: '/images/devtoberfest', top: 25,
}

// Route the fetch mock by URL: leaderboard, public board, personalized (401 by default).
function stub(opts: {
  leaderboard: unknown[]
  board: Record<string, unknown>
  myStatus?: number
  my?: Record<string, unknown>
}) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    if (u.includes('getLeaderboard')) return { ok: true, status: 200, json: async () => ({ value: opts.leaderboard }) }
    if (u.includes('getMyGameboard')) {
      const status = opts.myStatus ?? 401
      return { ok: status === 200, status, json: async () => opts.my ?? {} }
    }
    return { ok: true, status: 200, json: async () => opts.board } // getGameboard
  }))
}

describe('Gameboard.vue', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders an h1 and populates the leaderboard table from getLeaderboard', async () => {
    stub({
      leaderboard: [{ rank: 1, displayName: 'Tom J.', score: 120, level: 2, communityUrl: null }],
      board: { thresholds: [], totals: [], tracks: [], personalized: null },
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.findAll('tbody tr').length).toBe(1)
    expect(wrapper.text()).toContain('Tom J.')
    expect(wrapper.text()).toContain('120')
  })

  it('calls all three endpoints and swallows a 401 from getMyGameboard (anonymous)', async () => {
    stub({
      leaderboard: [],
      board: { thresholds: [], totals: [{ week: '1', trackId: 't1', totalPoints: 3000, totalCount: 5 }], tracks: [{ trackId: 't1', title: 'ABAP' }], personalized: null },
      myStatus: 401,
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0])
    expect(calls.some(u => u.includes('getLeaderboard'))).toBe(true)
    expect(calls.some(u => u.includes('getGameboard'))).toBe(true)
    expect(calls.some(u => u.includes('getMyGameboard'))).toBe(true)
    // anonymous → no crash, board still ready, no retry shown
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gameboard-retry"]').exists()).toBe(false)
  })

  it('degrades to an empty-but-valid board with a retry on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gameboard-retry"]').exists()).toBe(true)
  })
})
