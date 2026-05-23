import { describe, it, expect } from 'vitest'
import { suggestChartType } from '../useChartConfig'

describe('suggestChartType', () => {
  it('returns "bar" for 0 dims + 0 measures (reference fallback)', () => {
    // Reference returns 'bar' (not 'table') when nothing is configured.
    expect(suggestChartType([], [])).toBe('bar')
  })
  it('returns "kpi" for 0 dims + 1 measure', () => {
    expect(suggestChartType([], [{ column: 'x', aggregation: 'SUM', alias: 'sum_x' }])).toBe('kpi')
  })
  it('returns "bar" for 1 dim + 1 measure', () => {
    expect(suggestChartType(
      [{ column: 'd', dataType: 'NVARCHAR' }],
      [{ column: 'x', aggregation: 'SUM', alias: 'sum_x' }],
    )).toBe('bar')
  })
  it('returns "groupedBar" for 2 dims + 1 measure', () => {
    // Reference rule: 2 dimensions + 1 measure → 'heatmap' (not 'groupedBar').
    // 1 dimension + 2+ measures → 'groupedBar'. The plan's expected value
    // contradicts the reference; we match the reference per port-verbatim.
    expect(suggestChartType(
      [{ column: 'd1', dataType: 'NVARCHAR' }, { column: 'd2', dataType: 'NVARCHAR' }],
      [{ column: 'x', aggregation: 'SUM', alias: 'sum_x' }],
    )).toBe('heatmap')
  })
  it('returns "bar" for 0 dims + 2+ measures (reference rule)', () => {
    // Reference: 0 dims + >1 measures → 'bar'. The plan expected 'scatter',
    // but 'scatter' only triggers at >=2 dims AND >=2 measures.
    expect(suggestChartType(
      [],
      [
        { column: 'x', aggregation: 'SUM', alias: 'sum_x' },
        { column: 'y', aggregation: 'SUM', alias: 'sum_y' },
      ],
    )).toBe('bar')
  })
})
