// test/unit/kg/on-demand-cosine-rank-hana.test.js
// Structural probe for the HANA branch — mirrors concept-embedding-query-hana.test.js.

import { describe, it, expect, vi } from 'vitest'
import { rankTutorialsByQueryVector } from '../../../srv/lib/kg/on-demand-cosine-rank.js'

function fakeHanaDb(responses) {
  // Simple sequential response queue — one entry per db.run() call.
  const runs = []
  let i = 0
  return {
    kind: 'hana',
    run: vi.fn(async (sql, params) => {
      runs.push({ sql, params })
      return responses[i++] ?? []
    }),
    _runs: runs,
  }
}

describe('#1113 rankTutorialsByQueryVector HANA branch', () => {
  it('emits COSINE_SIMILARITY + GROUP BY, then hydrates metadata', async () => {
    const db = fakeHanaDb([
      // Phase 1: cosine query returns tutorial_id + score
      [
        { tutorial_id: 'tut-a', score: 0.9 },
        { tutorial_id: 'tut-b', score: 0.7 },
      ],
      // Phase 2: metadata hydrate
      [
        { id: 'tut-a', slug: 'a', title: 'A' },
        { id: 'tut-b', slug: 'b', title: 'B' },
      ],
    ])

    const out = await rankTutorialsByQueryVector({
      db,
      queryVector: new Float32Array(1536).fill(0.1),
      limit: 5,
    })

    expect(db._runs).toHaveLength(2)

    // Phase 1: cosine + MAX aggregate
    const phase1 = db._runs[0]
    expect(phase1.sql).toMatch(/MAX\s*\(\s*COSINE_SIMILARITY\s*\(\s*EMBEDDING\s*,\s*TO_REAL_VECTOR\s*\(\s*\?\s*\)\s*\)\s*\)/i)
    expect(phase1.sql).toMatch(/GROUP\s+BY\s+TUTORIAL_ID/i)
    expect(phase1.sql).toMatch(/SELECT\s+TOP\s+\?/i)
    expect(phase1.params[0]).toBe(5)
    expect(phase1.params[1].split(',')).toHaveLength(1536)

    // Phase 2: metadata by ID (delegated to fetchTutorialsByIds)
    const phase2 = db._runs[1]
    expect(phase2.sql).toMatch(/COM_SAP_DEVELOPERS_IMS_TUTORIALS/i)
    expect(phase2.sql).toMatch(/ID\s+IN/i)
    expect(phase2.params).toEqual(['tut-a', 'tut-b'])

    // Output shape
    expect(out).toEqual([
      { tutorialId: 'tut-a', slug: 'a', title: 'A', score: 0.9 },
      { tutorialId: 'tut-b', slug: 'b', title: 'B', score: 0.7 },
    ])
  })

  it('returns empty array when cosine query returns no rows', async () => {
    const db = fakeHanaDb([[]])
    const out = await rankTutorialsByQueryVector({
      db,
      queryVector: new Float32Array(1536),
      limit: 5,
    })
    expect(out).toEqual([])
    // Should NOT hit phase 2 when phase 1 is empty
    expect(db._runs).toHaveLength(1)
  })
})
