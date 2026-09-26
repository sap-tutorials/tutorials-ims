// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Gameboard from '../Gameboard.vue'
import type { LeaderboardRow, MountConfig } from '../types'

// Mock the realtime stream so tests can (a) stay quiet and (b) capture the
// completion callback the component registers, to prove a refetch keeps the
// current page. `streamHolder.onUpdate` is populated on connect().
const streamHolder: { onUpdate: (() => void) | null } = { onUpdate: null }
vi.mock('../useGameboardStream', () => ({
  useGameboardStream: () => ({
    connect: (_ws: string, _ctx: string, cb: () => void) => { streamHolder.onUpdate = cb },
    disconnect: () => { streamHolder.onUpdate = null },
  }),
}))

const CONFIG: MountConfig = {
  apiLeaderboard: '/gameboard/getLeaderboard',
  apiGameboard: '/gameboard/getGameboard',
  apiMyGameboard: '/gameboard/getMyGameboard',
  ws: '', imgBase: '/images/devtoberfest', top: 25,
}

// Route the fetch mock by URL: leaderboard, public board, personalized (401 by default).
// The leaderboard responder can be a static page or a function of the offset
// parsed from the URL, so pagination tests can return different slices per page.
function stub(opts: {
  leaderboard?: { rows: LeaderboardRow[]; total: number }
  leaderboardByOffset?: (offset: number) => { rows: LeaderboardRow[]; total: number }
  legacyArray?: LeaderboardRow[]  // legacy bare-array backend shape { value: [...] }
  board: Record<string, unknown>
  myStatus?: number
  my?: Record<string, unknown>
}) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    if (u.includes('getLeaderboard')) {
      if (opts.legacyArray) return { ok: true, status: 200, json: async () => ({ value: opts.legacyArray }) }
      const m = /offset=(\d+)/.exec(u)
      const offset = m ? Number(m[1]) : 0
      const page = opts.leaderboardByOffset ? opts.leaderboardByOffset(offset) : (opts.leaderboard ?? { rows: [], total: 0 })
      // Structured-return CAP function: body IS the envelope (+ @odata.context).
      return { ok: true, status: 200, json: async () => ({ '@odata.context': 'x', ...page }) }
    }
    if (u.includes('getMyGameboard')) {
      const status = opts.myStatus ?? 401
      return { ok: status === 200, status, json: async () => opts.my ?? {} }
    }
    return { ok: true, status: 200, json: async () => opts.board } // getGameboard
  }))
}

const row = (rank: number, name: string, score: number, level = 1, communityUrl: string | null = null): LeaderboardRow =>
  ({ rank, displayName: name, score, level, communityUrl })
const emptyBoard = { thresholds: [], totals: [], tracks: [], personalized: null }

describe('Gameboard.vue', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders an h1 and populates the leaderboard table from the { rows, total } envelope', async () => {
    stub({
      leaderboard: { rows: [row(1, 'Tom J.', 120, 2)], total: 1 },
      board: emptyBoard,
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.findAll('tbody tr').length).toBe(1)
    expect(wrapper.text()).toContain('Tom J.')
    expect(wrapper.text()).toContain('120')
  })

  it('still reads a legacy bare-array backend ({ value: [...] })', async () => {
    stub({ legacyArray: [row(1, 'Legacy L.', 50)], board: emptyBoard })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.findAll('tbody tr').length).toBe(1)
    expect(wrapper.text()).toContain('Legacy L.')
  })

  it('shows the participant count from total', async () => {
    stub({ leaderboard: { rows: [row(1, 'A', 10)], total: 1842 }, board: emptyBoard })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('[data-testid="participant-count"]').text()).toContain('1842')
  })

  it('paginates: Next requests the next offset and replaces the rows', async () => {
    const cfg = { ...CONFIG, top: 2 }
    stub({
      leaderboardByOffset: (offset) => offset === 0
        ? { rows: [row(1, 'P1', 90), row(2, 'P2', 80)], total: 4 }
        : { rows: [row(3, 'P3', 70), row(4, 'P4', 60)], total: 4 },
      board: emptyBoard,
    })
    const wrapper = mount(Gameboard, { props: { config: cfg } })
    await flushPromises()
    expect(wrapper.find('[data-testid="lb-page-status"]').text()).toContain('Page 1 of 2')
    expect(wrapper.text()).toContain('P1')
    await wrapper.find('[data-testid="lb-next"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="lb-page-status"]').text()).toContain('Page 2 of 2')
    expect(wrapper.text()).toContain('P3')
    expect(wrapper.text()).not.toContain('P1')
    // Absolute ranks preserved on page 2.
    expect(wrapper.text()).toContain('3')
  })

  it('a WS-triggered refetch reloads the CURRENT page, not page 1', async () => {
    const cfg = { ...CONFIG, top: 2 }
    const offsets: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.includes('getLeaderboard')) {
        const offset = Number(/offset=(\d+)/.exec(u)?.[1] ?? 0)
        offsets.push(offset)
        return { ok: true, status: 200, json: async () => ({ rows: [row(offset + 1, 'X', 10)], total: 4 }) }
      }
      if (u.includes('getMyGameboard')) return { ok: false, status: 401, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => emptyBoard }
    }))
    const wrapper = mount(Gameboard, { props: { config: cfg } })
    await flushPromises()
    await wrapper.find('[data-testid="lb-next"]').trigger('click')  // advance to offset 2
    await flushPromises()
    expect(streamHolder.onUpdate).toBeTypeOf('function')
    offsets.length = 0
    streamHolder.onUpdate!()       // simulate a completion broadcast
    await flushPromises()
    // The refetch used the CURRENT offset (2), never reset to 0.
    expect(offsets).toContain(2)
    expect(offsets).not.toContain(0)
  })

  it('highlights the caller row when they are on the visible page', async () => {
    stub({
      leaderboard: { rows: [row(1, 'Top T.', 200, 4, 'https://community.sap.com/u/1'), row(2, 'Me M.', 150, 3, 'https://community.sap.com/u/2')], total: 2 },
      board: emptyBoard,
      myStatus: 200,
      my: { status: 'joined', userId: 'u2', communityUrl: 'https://community.sap.com/u/2', score: 150, level: 3, rank: 2, total: 2, avatarIndex: 0, breakdown: [] },
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    const me = wrapper.findAll('[data-testid="lb-row-me"]')
    expect(me.length).toBe(1)
    expect(me[0].text()).toContain('Me M.')
    expect(wrapper.find('[data-testid="lb-row-me-sticky"]').exists()).toBe(false)
  })

  it('tags exactly ONE row as (you) even when scores are tied on the same rank (#2510 regression)', async () => {
    // Both rows share rank 1 (tie). Matching by rank would tag BOTH as "(you)";
    // matching by communityUrl tags only the caller's own row.
    stub({
      leaderboard: { rows: [row(1, 'Thomas J.', 0, 0, 'https://community.sap.com/u/139'), row(1, 'Daniel W.', 0, 0, 'https://community.sap.com/u/72')], total: 2 },
      board: emptyBoard,
      myStatus: 200,
      my: { status: 'joined', userId: 'u139', communityUrl: 'https://community.sap.com/u/139', score: 0, level: 0, rank: 1, total: 2, avatarIndex: 0, breakdown: [] },
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    const me = wrapper.findAll('[data-testid="lb-row-me"]')
    expect(me.length).toBe(1)
    expect(me[0].text()).toContain('Thomas J.')
    expect(me[0].text()).not.toContain('Daniel W.')
  })

  it('pins a sticky "You" row when the caller is ranked but off the visible page', async () => {
    stub({
      leaderboard: { rows: [row(1, 'Top T.', 200), row(2, 'Two T.', 190)], total: 137 },
      board: emptyBoard,
      myStatus: 200,
      my: { status: 'joined', userId: 'u9', score: 5, level: 0, rank: 99, total: 137, avatarIndex: 0, breakdown: [] },
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    const sticky = wrapper.find('[data-testid="lb-row-me-sticky"]')
    expect(sticky.exists()).toBe(true)
    expect(sticky.text()).toContain('99')
    expect(wrapper.find('[data-testid="lb-row-me"]').exists()).toBe(false)
  })

  it('calls all three endpoints and swallows a 401 from getMyGameboard (anonymous)', async () => {
    stub({
      leaderboard: { rows: [], total: 0 },
      board: { thresholds: [], totals: [{ week: '1', trackId: 't1', totalPoints: 3000, totalCount: 5 }], tracks: [{ trackId: 't1', title: 'ABAP' }], personalized: null },
      myStatus: 401,
    })
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0])
    expect(calls.some(u => u.includes('getLeaderboard'))).toBe(true)
    expect(calls.some(u => u.includes('getGameboard'))).toBe(true)
    expect(calls.some(u => u.includes('getMyGameboard'))).toBe(true)
    // anonymous → no crash, board still ready, no retry shown, no "you" row
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gameboard-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="lb-row-me-sticky"]').exists()).toBe(false)
  })

  it('degrades to an empty-but-valid board with a retry on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const wrapper = mount(Gameboard, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gameboard-retry"]').exists()).toBe(true)
  })
})
