import { describe, it, expect } from 'vitest'
import { csvHeader, csvRow, formatTruncationComment, streamCsv } from '../analytics-export-stream.js'

describe('analytics-export-stream — pure helpers', () => {
  it('quotes header columns containing comma or quote', () => {
    const h = csvHeader(['plain', 'has,comma', 'has"quote'])
    expect(h).toBe('plain,"has,comma","has""quote"\n')
  })

  it('emits empty string for null/undefined values', () => {
    const r = csvRow([null, undefined, 'x'])
    expect(r).toBe(',,x\n')
  })

  it('quotes values with newline, comma, or quote and doubles internal quotes', () => {
    const r = csvRow(['has,comma', 'has"quote', 'has\nnewline', 'plain'])
    expect(r).toBe('"has,comma","has""quote","has\nnewline",plain\n')
  })

  it('formats truncation comment for rowCount cap', () => {
    const c = formatTruncationComment({ cap: 'rowCount', rowCount: 100000 })
    expect(c).toMatch(/^\n# truncated:.*100000.*rows/i)
  })

  it('formats truncation comment for wallClock cap', () => {
    const c = formatTruncationComment({ cap: 'wallClock', rowCount: 47000 })
    expect(c).toMatch(/^\n# truncated:.*60s.*47000.*rows/i)
  })

  it('serializes Date objects as ISO strings', () => {
    const d = new Date('2026-05-31T10:00:00Z')
    expect(csvRow([d])).toBe('2026-05-31T10:00:00.000Z\n')
  })
})

describe('analytics-export-stream — paginated streamCsv', () => {
  // Mock db that records each query and serves rows from a synthetic dataset.
  function makeMockDb(totalRows, columns = ['id', 'value']) {
    const dataset = Array.from({ length: totalRows }, (_, i) =>
      Object.fromEntries(columns.map((c, j) => [c, j === 0 ? i : 'v' + i])))
    const queries = []
    return {
      queries,
      run: async (sql) => {
        queries.push(sql)
        const m = /LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i.exec(sql)
        if (!m) return dataset
        const lim = Number(m[1])
        const off = Number(m[2])
        return dataset.slice(off, off + lim)
      },
    }
  }

  // Mock express response that captures writes into a buffer.
  function makeMockRes() {
    const chunks = []
    return {
      chunks,
      ended: false,
      write: (s) => { chunks.push(s); return true },
      end: () => { chunks.push(null); /* marker */ },
      get text() { return chunks.filter(c => c !== null).join('') },
      setHeader: () => {},
    }
  }

  it('paginates the underlying SQL with LIMIT/OFFSET (does not materialize)', async () => {
    const db  = makeMockDb(12)
    const res = makeMockRes()
    await streamCsv({
      db,
      sql: 'SELECT * FROM (SELECT id, value FROM T) t LIMIT 100000',
      res,
      sqlLength: 0,
      pageSize: 5,
    })

    // 12 rows / 5 per page = 3 page reads. Each asks for pageSize because the
    // 100k cap leaves plenty of room; the third page only gets 2 rows back from
    // the source, which signals end-of-data.
    expect(db.queries.length).toBe(3)
    expect(db.queries[0]).toMatch(/LIMIT 5 OFFSET 0/)
    expect(db.queries[1]).toMatch(/LIMIT 5 OFFSET 5/)
    expect(db.queries[2]).toMatch(/LIMIT 5 OFFSET 10/)

    // Header + 12 rows + end-marker
    const lines = res.text.split('\n').filter(Boolean)
    expect(lines[0]).toBe('id,value')
    expect(lines.length).toBe(13)
  })

  it('honours the wrapper LIMIT and writes the rowCount truncation comment', async () => {
    const db  = makeMockDb(50)
    const res = makeMockRes()
    await streamCsv({
      db,
      sql: 'SELECT * FROM (SELECT id, value FROM T) t LIMIT 7',
      res,
      sqlLength: 0,
      pageSize: 5,
    })

    // First page: 5 rows. Second page: only 2 more before hitting the cap.
    expect(db.queries.length).toBe(2)
    expect(db.queries[1]).toMatch(/LIMIT 2 OFFSET 5/)
    expect(res.text).toMatch(/# truncated:.*100000 row cap.*7 rows/)
  })

  it('stops paginating when the underlying source returns fewer rows than requested', async () => {
    const db  = makeMockDb(3)
    const res = makeMockRes()
    await streamCsv({
      db,
      sql: 'SELECT * FROM (SELECT id, value FROM T) t LIMIT 100000',
      res,
      sqlLength: 0,
      pageSize: 5,
    })

    // Single page covers all 3 rows; no second query issued.
    expect(db.queries.length).toBe(1)
    expect(res.text.split('\n').filter(Boolean).length).toBe(4) // header + 3 rows
  })
})
