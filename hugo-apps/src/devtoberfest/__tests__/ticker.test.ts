import { describe, it, expect } from 'vitest'
import { buildTicker, DTF_TIPS } from '../ticker'

describe('devtoberfest ticker builder', () => {
  it('splices the event window in as the third line when known', () => {
    const lines = buildTicker('Sep 21 – Oct 18')
    expect(lines).toHaveLength(DTF_TIPS.length + 1)
    expect(lines[2]).toBe('Devtoberfest runs Sep 21 – Oct 18.')
    // Original tips are preserved around the spliced line.
    expect(lines[0]).toBe(DTF_TIPS[0])
    expect(lines[lines.length - 1]).toBe(DTF_TIPS[DTF_TIPS.length - 1])
  })

  it('omits the event line entirely when the window is empty', () => {
    const lines = buildTicker('')
    expect(lines).toEqual([...DTF_TIPS])
    // No fabricated stats and no half-built "Devtoberfest runs ." line.
    expect(lines.some((l) => l.includes('Devtoberfest runs'))).toBe(false)
  })

  it('does not mutate the shared DTF_TIPS array', () => {
    const before = [...DTF_TIPS]
    buildTicker('Sep 21 – Oct 18')
    expect([...DTF_TIPS]).toEqual(before)
  })
})
