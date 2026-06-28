// test/unit/srv/kg-path.test.js
//
// Unit tests for srv/lib/kg-path.js — the shared SPARQL exec + XML parse
// for tutorial path-finding. Mocks kg-sparql-client so no DB dependency.
//
// Issue #446, Phase 3 Track 3-B PR 5/6.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SPARQL client BEFORE importing kg-path (top-level await import
// matches the existing pattern in test/unit/kg-path-between-handler.test.js).
vi.mock('../../../srv/lib/kg-sparql-client.js', () => ({
  kgQuery: vi.fn(),
}))

const { kgQuery } = await import('../../../srv/lib/kg-sparql-client.js')
const { findPath, parsePathSparql } = await import('../../../srv/lib/kg-path.js')

// SPARQL XML fixture matching the shape that test/unit/kg-path-between-handler.test.js
// uses (and that joule-tool-find-path.js parses today). The KG procedure
// emits typed-literal bindings for the integer fields (datatype="...integer").
function buildXmlResponse(results) {
  const body = results
    .map(
      r => `
    <result>
      <binding name="b"><uri>https://developers.sap.com/kg/tutorial/${r.slug}</uri></binding>
      <binding name="pathType"><literal>${r.pathType}</literal></binding>
      <binding name="pathTypeRank"><literal datatype="http://www.w3.org/2001/XMLSchema#integer">${r.rank}</literal></binding>
      <binding name="hopCount"><literal datatype="http://www.w3.org/2001/XMLSchema#integer">${r.hop ?? 0}</literal></binding>
    </result>`,
    )
    .join('')
  return `<?xml version="1.0"?><sparql><results>${body}</results></sparql>`
}

describe('parsePathSparql', () => {
  it('extracts ordered steps from a typical SPARQL XML response', () => {
    const xml = buildXmlResponse([
      { slug: 'cap-handlers', pathType: 'PREREQ', rank: 1, hop: 1 },
      { slug: 'advanced', pathType: 'CO_COMPLETED', rank: 2, hop: 2 },
    ])
    const steps = parsePathSparql(xml)
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

  it('returns an empty array for an empty <results> block', () => {
    expect(parsePathSparql('<?xml version="1.0"?><sparql><results></results></sparql>')).toEqual([])
  })

  it('returns an empty array for empty / non-string input', () => {
    expect(parsePathSparql('')).toEqual([])
    expect(parsePathSparql(null)).toEqual([])
    expect(parsePathSparql(undefined)).toEqual([])
    expect(parsePathSparql(42)).toEqual([])
  })

  it('drops result blocks missing required bindings (b / pathType / pathTypeRank)', () => {
    // First block is complete; second is missing pathType.
    const xml = `<?xml version="1.0"?><sparql><results>
      <result>
        <binding name="b"><uri>https://developers.sap.com/kg/tutorial/keep-me</uri></binding>
        <binding name="pathType"><literal>PREREQ</literal></binding>
        <binding name="pathTypeRank"><literal datatype="http://www.w3.org/2001/XMLSchema#integer">1</literal></binding>
      </result>
      <result>
        <binding name="b"><uri>https://developers.sap.com/kg/tutorial/drop-me</uri></binding>
        <binding name="pathTypeRank"><literal datatype="http://www.w3.org/2001/XMLSchema#integer">2</literal></binding>
      </result>
    </results></sparql>`
    const steps = parsePathSparql(xml)
    expect(steps).toHaveLength(1)
    expect(steps[0].slug).toBe('keep-me')
  })

  it('defaults hopCount to 0 when binding is absent', () => {
    const xml = `<?xml version="1.0"?><sparql><results>
      <result>
        <binding name="b"><uri>https://developers.sap.com/kg/tutorial/no-hops</uri></binding>
        <binding name="pathType"><literal>SHARED_CONCEPT</literal></binding>
        <binding name="pathTypeRank"><literal>3</literal></binding>
      </result>
    </results></sparql>`
    const steps = parsePathSparql(xml)
    expect(steps).toHaveLength(1)
    expect(steps[0].hopCount).toBe(0)
  })

  it('preserves unknown IRIs as-is (no silent crash)', () => {
    const xml = `<?xml version="1.0"?><sparql><results>
      <result>
        <binding name="b"><uri>urn:something:else</uri></binding>
        <binding name="pathType"><literal>PREREQ</literal></binding>
        <binding name="pathTypeRank"><literal>1</literal></binding>
      </result>
    </results></sparql>`
    const steps = parsePathSparql(xml)
    expect(steps).toHaveLength(1)
    expect(steps[0].slug).toBe('urn:something:else')
  })

  it('tolerates literal bindings with optional datatype attribute', () => {
    // Both typed-literal (with datatype="...") and bare-literal forms must parse.
    const xml = `<?xml version="1.0"?><sparql><results>
      <result>
        <binding name="b"><uri>https://developers.sap.com/kg/tutorial/a</uri></binding>
        <binding name="pathType"><literal xml:lang="en">PREREQ</literal></binding>
        <binding name="pathTypeRank"><literal>1</literal></binding>
      </result>
    </results></sparql>`
    const steps = parsePathSparql(xml)
    expect(steps[0].pathType).toBe('PREREQ')
    expect(steps[0].pathTypeRank).toBe(1)
  })
})

describe('findPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls kgQuery with PATH_BETWEEN and tutorial IRI params, returns parsed steps', async () => {
    kgQuery.mockResolvedValue({
      response: buildXmlResponse([
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
