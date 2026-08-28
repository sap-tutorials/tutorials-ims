// test/unit/kg-path-v2-or-v1.test.js
//
// Unit tests for findPathV2OrV1 engine-selection ladder (issue #1253).
// Mocks kg-path-v2-client.js (kgPathV2) and kg-sparql-client.js (kgQuery,
// which findPath uses). No HANA.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../srv/lib/kg-path-v2-client.js', () => ({
  kgPathV2: vi.fn(),
}))
vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgQuery: vi.fn(),
  SparqlTimeoutError: class SparqlTimeoutError extends Error {},
  SparqlSyntaxError: class SparqlSyntaxError extends Error {},
}))

const { kgPathV2 } = await import('../../srv/lib/kg-path-v2-client.js')
const { kgQuery } = await import('../../srv/lib/kg-sparql-client.js')
const { findPathV2OrV1 } = await import('../../srv/lib/kg-path.js')
// KG_PATH_V2_ENABLED migrated env → DB (ImsConfig key flag.kg.pathV2, #2060):
// kg-path.js now reads it via isFlagEnabled(), so stubEnv no longer toggles it.
const { __setFlagForTest, __resetFlagsForTest } = await import('../../srv/lib/feature-flags/db-flags.js')

const PFX = 'https://developers.sap.com/kg/tutorial/'
function v1Json(slugs) {
  return JSON.stringify({
    head: { vars: ['b', 'pathType', 'pathTypeRank', 'hopCount'] },
    results: {
      bindings: slugs.map(s => ({
        b: { type: 'uri', value: `${PFX}${s}` },
        pathType: { type: 'literal', value: 'SHARED_CONCEPT' },
        pathTypeRank: { type: 'literal', value: '3' },
        hopCount: { type: 'literal', value: '0' },
      })),
    },
  })
}

const db = { run: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
  __resetFlagsForTest()
})

describe('findPathV2OrV1 engine selection', () => {
  it('flag on + v2 non-empty → returns engine v2 with vertices', async () => {
    __setFlagForTest('KG_PATH_V2_ENABLED', true)
    kgPathV2.mockResolvedValue([
      { pathRank: 1, hopCount: 2, vertices: [`tutorial:a`, `concept:x`, `tutorial:b`] },
    ])
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v2')
    expect(out.vertices).toEqual(['tutorial:a', 'concept:x', 'tutorial:b'])
    expect(kgPathV2).toHaveBeenCalledWith({ fromIri: `${PFX}a`, toIri: `${PFX}b` })
    expect(kgQuery).not.toHaveBeenCalled()
  })

  it('flag on + v2 empty → falls through to v1', async () => {
    __setFlagForTest('KG_PATH_V2_ENABLED', true)
    kgPathV2.mockResolvedValue([])
    kgQuery.mockResolvedValue({ response: v1Json(['b']) })
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v1')
    expect(out.candidates.map(c => c.slug)).toEqual(['b'])
  })

  it('flag on + v2 throws → falls through to v1 (fail-open)', async () => {
    __setFlagForTest('KG_PATH_V2_ENABLED', true)
    kgPathV2.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }))
    kgQuery.mockResolvedValue({ response: v1Json(['b']) })
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v1')
    expect(kgQuery).toHaveBeenCalledTimes(1)
  })

  it('flag off → v1 directly, kgPathV2 never called', async () => {
    __setFlagForTest('KG_PATH_V2_ENABLED', false)
    kgQuery.mockResolvedValue({ response: v1Json(['b']) })
    const out = await findPathV2OrV1({ db, fromSlug: 'a', toSlug: 'b' })
    expect(out.engine).toBe('v1')
    expect(kgPathV2).not.toHaveBeenCalled()
  })
})
