// test/unit/srv/kg-path.test.js
//
// Unit tests for srv/lib/kg-path.js — the shared SPARQL exec + JSON parse
// for tutorial path-finding. Mocks kg-sparql-client so no DB dependency.
//
// Issue #446, Phase 3 Track 3-B PR 5/6.
//
// #1129 — parsePathSparql was rewritten to parse the SPARQL-results+JSON
// shape that KG_QUERY actually emits (Accept: application/sparql-results+json,
// same as EXPLORE_GRAPH_BULK). The prior XML fixtures never matched the live
// proc output, so the parser silently returned [] in production → every
// /graph/path (and Joule find-learning-path) call 404'd "No path found"
// despite a fully-populated 83k-triple graph. These fixtures now mirror the
// real JSON binding shape verified against DEV HANA.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SPARQL client BEFORE importing kg-path (top-level await import
// matches the existing pattern in test/unit/kg-path-between-handler.test.js).
vi.mock('../../../srv/lib/kg-sparql-client.js', () => ({
  kgQuery: vi.fn(),
}))

const { kgQuery } = await import('../../../srv/lib/kg-sparql-client.js')
const { findPath, parsePathSparql } = await import('../../../srv/lib/kg-path.js')

// SPARQL-results+JSON fixture — the exact shape KG_QUERY emits (verified
// against DEV HANA 2026-07-09): b is a uri binding, pathType a plain literal,
// pathTypeRank/hopCount typed-literal integers.
function buildJsonResponse(results) {
  return JSON.stringify({
    head: { vars: ['b', 'pathType', 'pathTypeRank', 'hopCount'] },
    results: {
      bindings: results.map(r => {
        const binding = {
          b: { type: 'uri', value: `https://developers.sap.com/kg/tutorial/${r.slug}` },
          pathType: { type: 'literal', value: r.pathType },
          pathTypeRank: {
            type: 'literal',
            datatype: 'http://www.w3.org/2001/XMLSchema#int',
            value: String(r.rank),
          },
        }
        if (r.hop !== undefined) {
          binding.hopCount = {
            type: 'literal',
            datatype: 'http://www.w3.org/2001/XMLSchema#int',
            value: String(r.hop),
          }
        }
        return binding
      }),
    },
  })
}

describe('parsePathSparql', () => {
  it('extracts ordered steps from a typical SPARQL JSON response', () => {
    const json = buildJsonResponse([
      { slug: 'cap-handlers', pathType: 'PREREQ', rank: 1, hop: 1 },
      { slug: 'advanced', pathType: 'CO_COMPLETED', rank: 2, hop: 2 },
    ])
    const steps = parsePathSparql(json)
    expect(steps).toHaveLength(2)
    expect(steps[0]).toEqual({
      slug: 'cap-handlers',
      pathType: 'PREREQ',
      pathTypeRank: 1,
      hopCount: 1,
    })
    expect(steps[1]).toEqual({
      slug: 'advanced',
      pathType: 'CO_COMPLETED',
      pathTypeRank: 2,
      hopCount: 2,
    })
  })

  it('returns an empty array for a response with zero bindings', () => {
    expect(parsePathSparql(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }))).toEqual([])
  })

  it('returns an empty array for empty / non-string input', () => {
    expect(parsePathSparql('')).toEqual([])
    expect(parsePathSparql(null)).toEqual([])
    expect(parsePathSparql(undefined)).toEqual([])
    expect(parsePathSparql(42)).toEqual([])
  })

  it('returns an empty array for non-JSON (e.g. legacy XML) input rather than throwing', () => {
    // If the proc ever regresses to XML output, we must fail soft (empty
    // array + upstream canary), never throw. Mirrors parseExploreBindings.
    const xml = '<?xml version="1.0"?><sparql><results></results></sparql>'
    expect(parsePathSparql(xml)).toEqual([])
  })

  it('drops bindings missing required fields (b / pathType / pathTypeRank)', () => {
    const json = JSON.stringify({
      head: { vars: ['b', 'pathType', 'pathTypeRank'] },
      results: {
        bindings: [
          {
            b: { type: 'uri', value: 'https://developers.sap.com/kg/tutorial/keep-me' },
            pathType: { type: 'literal', value: 'PREREQ' },
            pathTypeRank: { type: 'literal', value: '1' },
          },
          {
            // missing pathType → dropped
            b: { type: 'uri', value: 'https://developers.sap.com/kg/tutorial/drop-me' },
            pathTypeRank: { type: 'literal', value: '2' },
          },
        ],
      },
    })
    const steps = parsePathSparql(json)
    expect(steps).toHaveLength(1)
    expect(steps[0].slug).toBe('keep-me')
  })

  it('defaults hopCount to 0 when binding is absent', () => {
    const json = buildJsonResponse([{ slug: 'no-hops', pathType: 'SHARED_CONCEPT', rank: 3 }])
    const steps = parsePathSparql(json)
    expect(steps).toHaveLength(1)
    expect(steps[0].hopCount).toBe(0)
  })

  it('preserves unknown IRIs as-is (no silent crash)', () => {
    const json = JSON.stringify({
      head: { vars: ['b', 'pathType', 'pathTypeRank'] },
      results: {
        bindings: [
          {
            b: { type: 'uri', value: 'urn:something:else' },
            pathType: { type: 'literal', value: 'PREREQ' },
            pathTypeRank: { type: 'literal', value: '1' },
          },
        ],
      },
    })
    const steps = parsePathSparql(json)
    expect(steps).toHaveLength(1)
    expect(steps[0].slug).toBe('urn:something:else')
  })
})

describe('findPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls kgQuery with PATH_BETWEEN and tutorial IRI params, returns parsed steps', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'a', pathType: 'PREREQ', rank: 1, hop: 1 },
        { slug: 'b', pathType: 'CO_COMPLETED', rank: 2, hop: 2 },
      ]),
      headers: '',
      latencyMs: 10,
    })

    const fakeDb = { run: vi.fn() }
    const result = await findPath({ db: fakeDb, fromSlug: 'a', toSlug: 'b' })

    expect(kgQuery).toHaveBeenCalledOnce()
    const args = kgQuery.mock.calls[0][0]
    expect(args.queryName).toBe('PATH_BETWEEN')
    expect(args.params.fromSlug).toBe('https://developers.sap.com/kg/tutorial/a')
    expect(args.params.toSlug).toBe('https://developers.sap.com/kg/tutorial/b')
    expect(args.db).toBe(fakeDb)

    expect(result).toHaveLength(2)
    expect(result[0].slug).toBe('a')
    expect(result[1].slug).toBe('b')
  })

  it('returns [] when kgQuery returns an empty response field', async () => {
    kgQuery.mockResolvedValue({ response: '', headers: '', latencyMs: 1 })
    const result = await findPath({ db: { run: vi.fn() }, fromSlug: 'x', toSlug: 'y' })
    expect(result).toEqual([])
  })

  it('returns [] when kgQuery returns null/undefined response (defensive)', async () => {
    kgQuery.mockResolvedValue(null)
    const result = await findPath({ db: { run: vi.fn() }, fromSlug: 'x', toSlug: 'y' })
    expect(result).toEqual([])
  })

  it('propagates kgQuery errors (timeout / syntax) to the caller', async () => {
    const err = new Error('timed out')
    err.name = 'SparqlTimeoutError'
    kgQuery.mockRejectedValue(err)
    await expect(
      findPath({ db: { run: vi.fn() }, fromSlug: 'x', toSlug: 'y' }),
    ).rejects.toThrow('timed out')
  })
})
