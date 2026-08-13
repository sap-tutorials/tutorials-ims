import { describe, it, expect } from 'vitest'
import { formatCountdown, formatDuration } from '../countdown'

// Fixed reference window used across cases.
const START = '2026-09-21T00:00:00Z'
const END = '2026-10-18T23:59:59Z'

function at(iso: string): number {
  return new Date(iso).getTime()
}

describe('formatDuration', () => {
  it('shows d/h/m when a day or more remains', () => {
    const ms = (5 * 86400 + 12 * 3600 + 30 * 60) * 1000
    expect(formatDuration(ms)).toBe('5d 12h 30m')
  })

  it('shows h/m when under a day', () => {
    const ms = (12 * 3600 + 30 * 60) * 1000
    expect(formatDuration(ms)).toBe('12h 30m')
  })

  it('shows m/s when under an hour', () => {
    const ms = (30 * 60 + 15) * 1000
    expect(formatDuration(ms)).toBe('30m 15s')
  })

  it('shows s only when under a minute', () => {
    expect(formatDuration(15 * 1000)).toBe('15s')
  })

  it('clamps negatives to 0s', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })

  it('rounds sub-second remainders down (floor)', () => {
    expect(formatDuration(1999)).toBe('1s')
  })
})

describe('formatCountdown', () => {
  it('phase "before" counts down to the start', () => {
    // 3 days, 4 hours before start
    const now = at(START) - (3 * 86400 + 4 * 3600) * 1000
    const r = formatCountdown(now, START, END)
    expect(r.phase).toBe('before')
    expect(r.label).toBe('Starts in 3d 4h 0m')
  })

  it('phase "during" counts down to the end', () => {
    // 5 days, 12 hours, 30 minutes before end
    const now = at(END) - (5 * 86400 + 12 * 3600 + 30 * 60) * 1000
    const r = formatCountdown(now, START, END)
    expect(r.phase).toBe('during')
    expect(r.label).toBe('Ends in 5d 12h 30m')
  })

  it('phase "ended" once now is at or past the end', () => {
    const r = formatCountdown(at(END), START, END)
    expect(r.phase).toBe('ended')
    expect(r.label).toBe('Ended')
  })

  it('exactly at start is already "during"', () => {
    const r = formatCountdown(at(START), START, END)
    expect(r.phase).toBe('during')
  })

  it('returns "invalid" phase for unparseable dates', () => {
    expect(formatCountdown(Date.parse('2026-01-01'), 'nope', END).phase).toBe('invalid')
    expect(formatCountdown(Date.parse('2026-01-01'), START, '').phase).toBe('invalid')
  })

  it('invalid phase has an empty label', () => {
    expect(formatCountdown(0, '', '').label).toBe('')
  })
})
