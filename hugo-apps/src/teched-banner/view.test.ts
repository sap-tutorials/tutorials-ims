import { describe, it, expect } from 'vitest'
import { bannerView } from './view'
import type { TechEdStatusResponse } from './view'

function status(startDate: string, endDate: string): TechEdStatusResponse {
  return { event: { name: 'SAP TechEd', startDate, endDate } }
}

const START = '2026-11-24T00:00:00Z'
const END = '2026-11-26T23:59:59Z'

describe('bannerView (TechEd)', () => {
  it('hides when status is null', () => {
    expect(bannerView(null, Date.now()).show).toBe(false)
  })

  it('hides when there is no event', () => {
    const s = status(START, END)
    s.event = null
    expect(bannerView(s, Date.now()).show).toBe(false)
  })

  it('hides when dates are missing', () => {
    expect(bannerView(status('', ''), Date.now()).show).toBe(false)
  })

  it('hides when dates are unparseable', () => {
    expect(bannerView(status('not-a-date', 'nope'), Date.now()).show).toBe(false)
  })

  it('before the event: shows a live countdown to the start', () => {
    const now = Date.parse(START) - (2 * 86400 + 3 * 3600 + 4 * 60) * 1000
    const v = bannerView(status(START, END), now)
    expect(v.show).toBe(true)
    expect(v.phase).toBe('before')
    expect(v.message).toBe('Starts in 2d 3h 4m')
    expect(v.window).toBe('Nov 24 – Nov 26')
  })

  it('during the event: shows the live-now message with the window', () => {
    const now = Date.parse(START) + 1 * 86400 * 1000
    const v = bannerView(status(START, END), now)
    expect(v.show).toBe(true)
    expect(v.phase).toBe('during')
    expect(v.message).toBe('Live now — join the free virtual event')
    expect(v.window).toBe('Nov 24 – Nov 26')
  })

  it('at the exact start instant: already "during"', () => {
    const v = bannerView(status(START, END), Date.parse(START))
    expect(v.phase).toBe('during')
  })

  it('after the event ends: STAYS VISIBLE with a watch-replays message', () => {
    const now = Date.parse(END) + 1000
    const v = bannerView(status(START, END), now)
    expect(v.show).toBe(true)
    expect(v.phase).toBe('after')
    expect(v.message).toBe('Watch the replays')
    expect(v.window).toBe('Nov 24 – Nov 26')
  })

  it('formats the window in UTC regardless of local tz', () => {
    const v = bannerView(
      status('2026-11-24T23:30:00Z', '2026-11-26T23:59:59Z'),
      Date.parse('2026-11-24T23:30:00Z'),
    )
    expect(v.window).toBe('Nov 24 – Nov 26')
  })
})
