import { describe, it, expect } from 'vitest'
import { trackTotalTime } from '../app-space-time'
import type { TimeTrack } from '../app-space-time'

// #3007: a track's "average time to complete" must not sum every tutorial when
// the track branches. Mandatory (linear) segments sum as-is; each branch segment
// contributes the AVERAGE of its alternatives' totals — the sum of all optional
// path times divided by the number of optional paths.

function tut(m: number) {
  return { type: 'TUTORIAL' as const, timeToComplete: m }
}

describe('trackTotalTime (#3007)', () => {
  it('sums a single linear segment (20 + 40 = 60)', () => {
    const track: TimeTrack = {
      segments: [{ order: 1, kind: 'linear', items: [tut(20), tut(40)] }],
    }
    expect(trackTotalTime(track)).toBe(60)
  })

  it('averages the lanes of a fork segment (lane A 30, lane B 50 => 40)', () => {
    const track: TimeTrack = {
      segments: [
        { order: 1, kind: 'fork', lanes: [
          { label: 'A', items: [tut(30)] },
          { label: 'B', items: [tut(50)] },
        ] },
      ],
    }
    expect(trackTotalTime(track)).toBe(40)
  })

  it('averages a fork over per-lane TOTALS, not per-tutorial (lane A 10+20=30, lane B 50 => 40)', () => {
    const track: TimeTrack = {
      segments: [
        { order: 1, kind: 'fork', lanes: [
          { label: 'A', items: [tut(10), tut(20)] },
          { label: 'B', items: [tut(50)] },
        ] },
      ],
    }
    expect(trackTotalTime(track)).toBe(40)
  })

  it('adds mandatory linear time to averaged fork time (60 + avg(30,50)=40 => 100)', () => {
    const track: TimeTrack = {
      segments: [
        { order: 1, kind: 'linear', items: [tut(20), tut(40)] },
        { order: 2, kind: 'fork', lanes: [
          { label: 'A', items: [tut(10), tut(20)] },
          { label: 'B', items: [tut(50)] },
        ] },
      ],
    }
    expect(trackTotalTime(track)).toBe(100)
  })

  it('averages a parallel-any cluster — pick any one (20, 40, 60 => 40)', () => {
    const track: TimeTrack = {
      segments: [{ order: 1, kind: 'parallel-any', items: [tut(20), tut(40), tut(60)] }],
    }
    expect(trackTotalTime(track)).toBe(40)
  })

  it('sums contributions across multiple branch segments (linear 60 + fork avg 40 + cluster avg 30 => 130)', () => {
    const track: TimeTrack = {
      segments: [
        { order: 1, kind: 'linear', items: [tut(60)] },
        { order: 2, kind: 'fork', lanes: [
          { label: 'A', items: [tut(30)] },
          { label: 'B', items: [tut(50)] },
        ] }, // avg 40
        { order: 3, kind: 'parallel-any', items: [tut(20), tut(40)] }, // avg 30
      ],
    }
    expect(trackTotalTime(track)).toBe(130)
  })

  it('ignores non-tutorial items (synthetic prize checkpoints have timeToComplete 0)', () => {
    const track: TimeTrack = {
      segments: [
        { order: 1, kind: 'fork', lanes: [
          { label: 'A', items: [tut(40), { type: 'CHECKPOINT', timeToComplete: 0 }] },
          { label: 'B', items: [tut(60)] },
        ] },
      ],
    }
    expect(trackTotalTime(track)).toBe(50)
  })

  it('falls back to flat items[] when a track has no segments (legacy payload)', () => {
    const track: TimeTrack = {
      items: [tut(15), tut(45), { type: 'CHECKPOINT', timeToComplete: 0 }],
    }
    expect(trackTotalTime(track)).toBe(60)
  })

  it('returns 0 for an empty track', () => {
    expect(trackTotalTime({ segments: [] })).toBe(0)
    expect(trackTotalTime({ items: [] })).toBe(0)
    expect(trackTotalTime({})).toBe(0)
  })

  it('treats an empty fork lane list as contributing 0 (no divide-by-zero)', () => {
    const track: TimeTrack = {
      segments: [{ order: 1, kind: 'fork', lanes: [] }],
    }
    expect(trackTotalTime(track)).toBe(0)
  })
})
