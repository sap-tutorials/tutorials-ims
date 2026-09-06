import { describe, it, expect } from 'vitest'
import { bannerView } from './view'
import type { StatusResponse } from '../devtoberfest/types'

function status(startDate: string, endDate: string): StatusResponse {
  return {
    event: { name: 'Devtoberfest', startDate, endDate },
    joined: false,
    termsVersion: 1,
    termsRequired: true,
    contentRulesUrl: '',
    faqUrl: '',
    gameboardUrl: '',
    activitiesUrl: '',
    bannerUrl: '',
  }
}

const START = '2026-10-01T00:00:00Z'
const END = '2026-10-31T23:59:59Z'

describe('bannerView', () => {
  it('hides when status is null', () => {
    expect(bannerView(null, Date.now()).show).toBe(false)
  })

  it('hides when there is no active event', () => {
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
    // 2 days, 3 hours, 4 minutes before start
    const now = Date.parse(START) - (2 * 86400 + 3 * 3600 + 4 * 60) * 1000
    const v = bannerView(status(START, END), now)
    expect(v.show).toBe(true)
    expect(v.phase).toBe('before')
    expect(v.message).toBe('Starts in 2d 3h 4m')
    expect(v.window).toBe('Oct 1 – Oct 31')
  })

  it('during the event: shows the live-now message with the window', () => {
    const now = Date.parse(START) + 5 * 86400 * 1000
    const v = bannerView(status(START, END), now)
    expect(v.show).toBe(true)
    expect(v.phase).toBe('during')
    expect(v.message).toBe('Live now')
    expect(v.window).toBe('Oct 1 – Oct 31')
  })

  it('at the exact start instant: already "during"', () => {
    const v = bannerView(status(START, END), Date.parse(START))
    expect(v.phase).toBe('during')
  })

  it('after the event ends: hidden', () => {
    const now = Date.parse(END) + 1000
    expect(bannerView(status(START, END), now).show).toBe(false)
  })

  it('formats the window in UTC regardless of local tz', () => {
    // A start at 23:30 UTC must still label as the UTC calendar day.
    const v = bannerView(status('2026-10-01T23:30:00Z', '2026-10-31T23:59:59Z'), Date.parse('2026-10-01T23:30:00Z'))
    expect(v.window).toBe('Oct 1 – Oct 31')
  })
})
