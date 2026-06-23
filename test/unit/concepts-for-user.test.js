// test/unit/concepts-for-user.test.js
// Unit tests for srv/lib/kg/concepts-for-user.js (issue #445 Phase 2).
// Pure JS, mocks db.run + kgAdminRunSparql.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgAdminRunSparql: vi.fn(async () => ({
    response: `<?xml version="1.0"?>
<sparql xmlns="http://www.w3.org/2005/sparql-results#">
  <head><variable name="c"/><variable name="status"/></head>
  <results>
    <result>
      <binding name="c"><uri>https://developers.sap.com/kg/concept/cap-handlers</uri></binding>
      <binding name="status"><literal>COMPLETED</literal></binding>
    </result>
    <result>
      <binding name="c"><uri>https://developers.sap.com/kg/concept/cap-cds-query</uri></binding>
      <binding name="status"><literal>IN_PROGRESS</literal></binding>
    </result>
  </results>
</sparql>`,
    headers: '',
    latencyMs: 12,
  })),
}))

const { getConceptsForUser } = await import('../../srv/lib/kg/concepts-for-user.js')

function makeDb({ taskRecords = [], slugLookup = {} } = {}) {
  return {
    run: vi.fn(async (sqlOrCqn) => {
      const sql = typeof sqlOrCqn === 'string' ? sqlOrCqn : String(sqlOrCqn)
      if (sql.includes('TASKRECORDS')) return taskRecords
      if (sql.includes('TUTORIALS')) {
        // The helper queries Tutorials by LEGACYID (not by ID) since
        // TaskRecords.taskLegacyId is the join key. Mock returns rows
        // shaped {LEGACYID, SLUG}.
        return Object.entries(slugLookup).map(([LEGACYID, SLUG]) => ({ LEGACYID: Number(LEGACYID), SLUG }))
      }
      return []
    }),
  }
}

describe('getConceptsForUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects empty userId with TypeError', async () => {
    await expect(getConceptsForUser({ db: makeDb(), userId: '' })).rejects.toThrow(TypeError)
  })

  it('rejects malformed userId with TypeError', async () => {
    await expect(getConceptsForUser({ db: makeDb(), userId: 'has spaces' })).rejects.toThrow(TypeError)
  })

  it('returns empty { learned, partial } for user with no TaskRecords', async () => {
    const db = makeDb({ taskRecords: [] })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    expect(r).toEqual({ learned: [], partial: [], truncatedAt500: false })
  })

  it('partitions concepts by STATUS (COMPLETED→learned; IN_PROGRESS→partial)', async () => {
    const db = makeDb({
      taskRecords: [
        { TASKLEGACYID: 100, STATUS: 'COMPLETED' },
        { TASKLEGACYID: 200, STATUS: 'IN_PROGRESS' },
      ],
      slugLookup: { '100': 'cap-handlers-tutorial', '200': 'cds-query-tutorial' },
    })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    expect(r.learned).toContain('cap-handlers')
    expect(r.partial).toContain('cap-cds-query')
  })

  it('sets truncatedAt500: true when TaskRecords exceed cap', async () => {
    const taskRecords = Array.from({ length: 501 }, (_, i) => ({ TASKLEGACYID: i + 1, STATUS: 'COMPLETED' }))
    const slugLookup = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`${i + 1}`, `slug-${i + 1}`]))
    const db = makeDb({ taskRecords, slugLookup })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    expect(r.truncatedAt500).toBe(true)
  })

  it('dedupes: a concept in both buckets resolves to learned only', async () => {
    const db = makeDb({
      taskRecords: [{ TASKLEGACYID: 1, STATUS: 'COMPLETED' }, { TASKLEGACYID: 2, STATUS: 'IN_PROGRESS' }],
      slugLookup: { '1': 'cap', '2': 'cap' },
    })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    const overlap = r.learned.filter(c => r.partial.includes(c))
    expect(overlap).toEqual([])
  })
})
