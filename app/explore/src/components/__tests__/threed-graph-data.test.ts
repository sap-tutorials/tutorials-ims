import { describe, it, expect } from 'vitest'
import { toGraphData } from '../threed-graph-data'

describe('toGraphData', () => {
  const nodes = [
    { id: 't:a', type: 'tutorial', slug: 'a', label: 'A', rank: 0.5 },
    { id: 'c:b', type: 'concept', slug: 'b', label: 'B' },
  ] as any
  const edges = [{ s: 't:a', p: 'teaches', o: 'c:b' }] as any

  it('maps edges to source/target links and drops dangling', () => {
    const withDangling = [...edges, { s: 't:a', p: 'requires', o: 'zzz' }] as any
    const { links } = toGraphData(nodes, withDangling)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ source: 't:a', target: 'c:b' })
  })

  it('sizes by rank when present, else degree', () => {
    const { nodes: gn } = toGraphData(nodes, edges)
    const a = gn.find(n => n.id === 't:a')
    const b = gn.find(n => n.id === 'c:b')
    expect(a.val).toBeGreaterThan(1)   // rank-driven: rank 0.5 → val 1 + 0.5*10 = 6
    expect(a.val).toBe(6)              // exact check: 1 + 0.5 * 10
    expect(b.val).toBe(1 + 1)         // degree 1, no rank
  })
})
