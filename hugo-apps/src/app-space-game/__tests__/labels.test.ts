import { describe, it, expect } from 'vitest'
import { labelModes, stackRects, tidyTitle } from '../labels'

describe('labelModes', () => {
  const xs = [0, 6, 12, 18, 24, 30, 90]

  it('shows full titles only for the nearest coins to Kasimir', () => {
    const m = labelModes(xs, 13, 15, 20)
    expect(m.filter(x => x === 'full')).toHaveLength(2)
    expect(m[2]).toBe('full')
    expect(m[1] === 'full' || m[3] === 'full').toBe(true)
  })

  it('shows badges for other on-screen coins and hides off-screen ones', () => {
    const m = labelModes(xs, 13, 15, 20)
    expect(m[5]).toBe('badge')
    expect(m[6]).toBe('hidden')
  })

  it('shows no full titles when no coin is near Kasimir', () => {
    const m = labelModes([0, 40], 20, 20, 30)
    expect(m).toEqual(['badge', 'badge'])
  })
})

describe('stackRects', () => {
  it('leaves non-overlapping rects untouched', () => {
    expect(stackRects([{ x: 100, y: 200, w: 80, h: 30 }, { x: 300, y: 200, w: 80, h: 30 }])).toEqual([0, 0])
  })

  it('lifts a colliding rect above its neighbour', () => {
    const rects = [{ x: 100, y: 200, w: 160, h: 40 }, { x: 180, y: 200, w: 160, h: 40 }]
    const off = stackRects(rects, 6)
    expect(off[0]).toBe(0)
    expect(off[1]).toBe(46)
  })

  it('produces a layout with no overlaps for a dense row', () => {
    const rects = Array.from({ length: 6 }, (_, i) => ({ x: 100 + i * 50, y: 300, w: 200, h: 44 }))
    const off = stackRects(rects, 4)
    const boxes = rects.map((r, i) => ({ l: r.x - r.w / 2, r: r.x + r.w / 2, b: r.y - off[i], t: r.y - off[i] - r.h }))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const overlap = a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
        expect(overlap).toBe(false)
      }
    }
  })
})

describe('tidyTitle', () => {
  it('keeps short titles and collapses whitespace', () => {
    expect(tidyTitle('  Build   an  App ')).toBe('Build an App')
  })
  it('cuts long titles at a word boundary with an ellipsis', () => {
    const t = tidyTitle('Create a SAP Fiori elements application with SAP Business Application Studio and deploy it', 50)
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(51)
    expect(t).not.toMatch(/\s…$/)
  })
})
