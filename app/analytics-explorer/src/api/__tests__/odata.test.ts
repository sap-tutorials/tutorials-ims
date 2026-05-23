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

  it('appends orderby + topcount', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [],
      orderBy: { column: 'count_id', direction: 'desc' },
      topN: 10,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('topcount(10,count_id)')
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
})
