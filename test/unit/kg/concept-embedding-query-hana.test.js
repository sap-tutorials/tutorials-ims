// test/unit/kg/concept-embedding-query-hana.test.js
// Structural probe with a mocked db.run — verifies the HANA branch emits the
// expected COSINE_SIMILARITY SQL shape. Live behavior is proven in the hybrid
// test (test/hybrid/kg-hana-cosine.test.js).

import { describe, it, expect, vi } from 'vitest'
import { topConceptsByCosine } from '../../../srv/lib/kg/concept-embedding-query.js'

function fakeHanaDb(rows) {
  const runs = []
  return {
    kind: 'hana',
    run: vi.fn(async (sql, params) => {
      runs.push({ sql, params })
      return rows
    }),
    _runs: runs,
  }
}

describe('#1113 topConceptsByCosine HANA branch', () => {
  it('emits a single COSINE_SIMILARITY query with TO_REAL_VECTOR(?)', async () => {
    const db = fakeHanaDb([
      { id: 'c1', slug: 'a', name: 'A', score: 0.9 },
      { id: 'c2', slug: 'b', name: 'B', score: 0.7 },
    ])
    const q = new Float32Array(1536).fill(0.1)
    const out = await topConceptsByCosine({ db, queryVector: q, limit: 5 })

    // One SQL round-trip, not two.
    expect(db._runs).toHaveLength(1)
    const { sql, params } = db._runs[0]

    // Uses the vector engine.
    expect(sql).toMatch(/COSINE_SIMILARITY\s*\(\s*EMBEDDING_VEC\s*,\s*TO_REAL_VECTOR\s*\(\s*\?\s*\)\s*\)/i)
    // Guards against the transient state during backfill.
    expect(sql).toMatch(/EMBEDDING_VEC\s+IS\s+NOT\s+NULL/i)
    // Publish gate preserved.
    expect(sql).toMatch(/STATUS\s*=\s*'ACTIVE'/i)
    expect(sql).toMatch(/PUBLISHEDAT\s+IS\s+NOT\s+NULL/i)
    expect(sql).toMatch(/MERGEDINTO_ID\s+IS\s+NULL/i)
    // TOP is a bound param so the plan cache is stable across callers.
    expect(sql).toMatch(/SELECT\s+TOP\s+\?/i)

    // Params: [limit, vectorString]
    expect(params[0]).toBe(5)
    expect(typeof params[1]).toBe('string')
    expect(params[1].startsWith('[')).toBe(true)
    expect(params[1].endsWith(']')).toBe(true)
    // Exactly 1536 comma-separated floats.
    const inner = params[1].slice(1, -1)
    expect(inner.split(',')).toHaveLength(1536)
    // Precision hint: 6 decimals.
    expect(inner.split(',')[0]).toMatch(/^-?\d\.\d{6}$/)

    // Passthrough of the DB row shape.
    expect(out).toEqual([
      { id: 'c1', slug: 'a', name: 'A', score: 0.9 },
      { id: 'c2', slug: 'b', name: 'B', score: 0.7 },
    ])
  })

  it('returns empty array when HANA returns no rows', async () => {
    const db = fakeHanaDb([])
    const out = await topConceptsByCosine({
      db,
      queryVector: new Float32Array(1536),
      limit: 3,
    })
    expect(out).toEqual([])
  })

  it('accepts plain arrays as well as Float32Array', async () => {
    const db = fakeHanaDb([])
    await topConceptsByCosine({
      db,
      queryVector: new Array(1536).fill(0),
      limit: 3,
    })
    const { params } = db._runs[0]
    expect(params[1].split(',')).toHaveLength(1536)
  })
})
