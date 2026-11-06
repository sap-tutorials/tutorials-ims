import { describe, it, expect } from 'vitest'
import { reset, collect, onHit } from '../rings'

describe('rings state', () => {
  it('reset() returns { count: 0 }', () => {
    const state = reset()
    expect(state.count).toBe(0)
  })

  it('collect({count: 3}) returns { count: 4 } without mutating input', () => {
    const original = { count: 3 }
    const collected = collect(original)
    expect(collected.count).toBe(4)
    expect(original.count).toBe(3)
  })

  it('onHit({count: 7}) returns next.count === 0 and scattered === 7', () => {
    const state = { count: 7 }
    const { next, scattered } = onHit(state)
    expect(next.count).toBe(0)
    expect(scattered).toBe(7)
  })

  it('onHit({count: 0}) returns next.count === 0 and scattered === 0 (harmless no-op)', () => {
    const state = { count: 0 }
    const { next, scattered } = onHit(state)
    expect(next.count).toBe(0)
    expect(scattered).toBe(0)
  })

  it('collect(collect(reset())) chains to count 2', () => {
    const chained = collect(collect(reset()))
    expect(chained.count).toBe(2)
  })
})
