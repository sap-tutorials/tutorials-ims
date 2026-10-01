import { describe, it, expect } from 'vitest'
import { colorForNodeType, edgeColorForPredicate, NODE_COLORS } from '../node-colors'

describe('node-colors', () => {
  it('maps known node types to their SAP colors', () => {
    expect(colorForNodeType('tutorial')).toBe('#0a6ed1')
    expect(colorForNodeType('concept')).toBe('#107e3e')
  })
  it('falls back to neutral grey for an unknown type', () => {
    // @ts-expect-error deliberately invalid
    expect(colorForNodeType('nope')).toBe('#8c8c8c')
  })
  it('defaults edges to grey and colors session predicates', () => {
    expect(edgeColorForPredicate('teaches')).toBe('#999999')
    expect(edgeColorForPredicate('presents')).toBe('#e97800')
  })
  it('covers every NodeType (no undefined)', () => {
    for (const c of Object.values(NODE_COLORS)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
})
