import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NEW_WINDOW_MS, isWithinNewWindow } from './freshness'

describe('NEW_WINDOW_MS', () => {
  it('is 31 days in milliseconds', () => {
    expect(NEW_WINDOW_MS).toBe(31 * 24 * 60 * 60 * 1000)
  })
})

describe('isWithinNewWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false for undefined input', () => {
    expect(isWithinNewWindow(undefined)).toBe(false)
  })

  it('returns false for an unparseable string', () => {
    expect(isWithinNewWindow('not-a-date')).toBe(false)
  })

  it('returns true for a timestamp 1 day ago', () => {
    expect(isWithinNewWindow('2026-05-31T12:00:00Z')).toBe(true)
  })

  it('returns true for a timestamp exactly 31 days ago', () => {
    // 2026-06-01T12:00:00Z minus 31 days = 2026-05-01T12:00:00Z
    expect(isWithinNewWindow('2026-05-01T12:00:00Z')).toBe(true)
  })

  it('returns false for a timestamp 32 days ago', () => {
    expect(isWithinNewWindow('2026-04-30T12:00:00Z')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isWithinNewWindow('')).toBe(false)
  })
})
