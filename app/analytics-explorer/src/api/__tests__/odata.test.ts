import { describe, it, expect } from 'vitest'
import { buildApplyUrl } from '../odata'

describe('buildApplyUrl', () => {
  it('builds groupby + aggregate URL for one dim, one measure', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [],
      orderBy: null,
      topN: null,
    })
    expect(url).toContain('/admin/analytics/TaskRecords?')
    expect(url).toContain('$apply=')
    expect(decodeURIComponent(url)).toContain('groupby((status)')
    expect(decodeURIComponent(url)).toContain('aggregate(id with countdistinct as count_id)')
  })

  it('includes filter() before groupby', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [{ column: 'status', operator: 'eq', value: 'COMPLETED' }],
      orderBy: null,
      topN: null,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded.indexOf('filter(')).toBeLessThan(decoded.indexOf('groupby('))
    expect(decoded).toContain("filter(status eq 'COMPLETED')")
  })

  it('appends orderby + top when both supplied', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [],
      orderBy: { column: 'count_id', direction: 'desc' },
      topN: 10,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('orderby(count_id desc)')
    expect(decoded).toContain('top(10)')
    expect(decoded).not.toContain('topcount')
  })

  it('synthesizes orderby desc on the first measure when topN is set without explicit orderby', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [],
      orderBy: null,
      topN: 5,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('orderby(count_id desc)')
    expect(decoded).toContain('top(5)')
  })

  it('handles SUM aggregation', () => {
    const url = buildApplyUrl({
      entity: 'CompletionAnalytics',
      dimensions: [{ column: 'mission', dataType: 'NVARCHAR' }],
      measures: [{ column: 'duration', aggregation: 'SUM', alias: 'sum_duration' }],
      filters: [],
      orderBy: null,
      topN: null,
    })
    expect(decodeURIComponent(url)).toContain('aggregate(duration with sum as sum_duration)')
  })

  it('topN throws when no usable column', () => {
    expect(() => buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [],
      measures: [],
      filters: [],
      orderBy: null,
      topN: 10,
    })).toThrow(/topN requires/)
  })

  it('rejects invalid operator', () => {
    expect(() => buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [{ column: 'status', operator: 'OR', value: 'COMPLETED' }],
      orderBy: null,
      topN: null,
    })).toThrow(/invalid operator/)
  })

  it('rejects invalid identifier', () => {
    expect(() => buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [{ column: 'a; drop table b', operator: 'eq', value: 'x' }],
      orderBy: null,
      topN: null,
    })).toThrow(/invalid/)
  })

  it("quote-escapes single quotes in string filter values", () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [{ column: 'name', operator: 'eq', value: "O'Brien" }],
      orderBy: null,
      topN: null,
    })
    expect(decodeURIComponent(url)).toContain("name eq 'O''Brien'")
  })

  it('numeric filter values are not quoted', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [{ column: 'count', operator: 'eq', value: 42 }],
      orderBy: null,
      topN: null,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('count eq 42')
    expect(decoded).not.toContain("eq '42'")
  })
})
