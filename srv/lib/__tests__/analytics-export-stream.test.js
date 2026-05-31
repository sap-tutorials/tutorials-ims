import { describe, it, expect } from 'vitest'
import { csvHeader, csvRow, formatTruncationComment } from '../analytics-export-stream.js'

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
