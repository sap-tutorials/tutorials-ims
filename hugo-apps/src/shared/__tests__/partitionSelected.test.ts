import { describe, it, expect } from 'vitest'
import { partitionSelected } from '../partitionSelected'

describe('partitionSelected', () => {
  it('moves selected to front, stable within each group', () => {
    const list = ['a', 'b', 'c', 'd']
    const sel = new Set(['b', 'd'])
    expect(partitionSelected(list, x => sel.has(x))).toEqual(['b', 'd', 'a', 'c'])
  })
  it('returns a new array and does not mutate input', () => {
    const list = ['a', 'b']
    const out = partitionSelected(list, () => false)
    expect(out).toEqual(['a', 'b'])
    expect(out).not.toBe(list)
  })
  it('all-selected and none-selected preserve original order', () => {
    expect(partitionSelected(['a','b','c'], () => true)).toEqual(['a','b','c'])
    expect(partitionSelected(['a','b','c'], () => false)).toEqual(['a','b','c'])
  })
})
