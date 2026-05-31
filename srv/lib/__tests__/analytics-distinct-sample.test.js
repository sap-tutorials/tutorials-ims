import { describe, it, expect } from 'vitest'
import { validateSampleDistinctRequest, buildSampleDistinctSql } from '../analytics-distinct-sample.js'

describe('analytics-distinct-sample — pure helpers', () => {
  const allowedTables = new Set(['Tasks', 'TASKS'])
  const annot = (mode, sample) => ({ filterMode: mode, filterSample: sample })

  it('rejects table not in allowlist', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'NotAllowed', column: 'status',
      allowedTables, columnAnnotation: annot('enum', true),
    })).toThrow(/not exposed/i)
  })

  it('rejects column with filterMode != enum', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'Tasks', column: 'status',
      allowedTables, columnAnnotation: annot('free', false),
    })).toThrow(/not eligible/i)
  })

  it('rejects column with sample: false', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'Tasks', column: 'status',
      allowedTables, columnAnnotation: annot('enum', false),
    })).toThrow(/not eligible/i)
  })

  it('rejects column name with non-identifier characters', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'Tasks', column: 'status; DROP TABLE Tasks; --',
      allowedTables, columnAnnotation: annot('enum', true),
    })).toThrow(/bad column/i)
  })

  it('builds DISTINCT SQL with cap+1 limit for truncation detection', () => {
    const sql = buildSampleDistinctSql({ table: 'Tasks', column: 'status', cap: 100 })
    expect(sql).toMatch(/SELECT DISTINCT "status" AS V FROM Tasks/)
    expect(sql).toMatch(/LIMIT 101/)
  })

  it('clamps cap to [1, 200]', () => {
    expect(buildSampleDistinctSql({ table: 'Tasks', column: 'status', cap: 1000 })).toMatch(/LIMIT 201/)
    expect(buildSampleDistinctSql({ table: 'Tasks', column: 'status', cap: 0 })).toMatch(/LIMIT 2/)
  })
})
