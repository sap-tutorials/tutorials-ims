// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const exportSpy = vi.fn(async () => {})

vi.mock('../../../composables/useExport', () => ({
  useExport: () => ({
    exportCsv: exportSpy,
    isExporting: { value: false },
    lastError: { value: null },
  }),
}))

// Mock ChartRenderer + ChartTypeSwitcher to avoid ECharts initializing in
// happy-dom (Canvas not implemented; zrender's Layer.initContext throws).
vi.mock('../../ChartRenderer.vue', () => ({
  default: { name: 'ChartRendererStub', template: '<div data-test="chart-stub" />' },
}))
vi.mock('../../ChartTypeSwitcher.vue', () => ({
  default: { name: 'ChartTypeSwitcherStub', template: '<div />' },
}))

import ResultsTab from '../ResultsTab.vue'

const baseProps = {
  results: {
    columns: ['event_ID', 'cnt'],
    rows: [['evt1', 42], ['evt2', 17]] as Array<Array<string | number | null>>,
    metadata: { rowCount: 2, truncated: false, durationMs: 50 },
    privacy: { mode: 'raw' as const, suppressedCells: 0 },
  },
  generatedSql: 'SELECT event_ID, count(*) AS cnt FROM TaskRecords GROUP BY event_ID',
  canDrillDown: () => true,
}

describe('ResultsTab', () => {
  beforeEach(() => {
    exportSpy.mockClear()
    if (!URL.createObjectURL) {
      ;(URL as any).createObjectURL = vi.fn(() => 'blob:fake')
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })

  it('renders the table by default', () => {
    const w = mount(ResultsTab, { props: baseProps })
    // Headers come from ResultsTable's header-row.
    expect(w.text()).toContain('event_ID')
    expect(w.text()).toContain('cnt')
  })

  it('renders the privacy badge from results.privacy', () => {
    const w = mount(ResultsTab, { props: baseProps })
    expect(w.text().toLowerCase()).toContain('raw query')
  })

  it('toggles to chart view via the chart button', async () => {
    const w = mount(ResultsTab, {
      props: {
        ...baseProps,
        // Numeric column ensures chartEnabled is true.
        results: {
          ...baseProps.results,
          columns: ['event_ID', 'cnt'],
          rows: [['evt1', 42], ['evt2', 17]],
        },
      },
    })
    expect(w.find('[data-test="results-view-table"]').classes()).toContain('active')
    await w.find('[data-test="results-view-chart"]').trigger('click')
    expect(w.find('[data-test="results-view-chart"]').classes()).toContain('active')
  })

  it('emits drilldown event when context menu confirmed', async () => {
    const w = mount(ResultsTab, { props: baseProps })
    await (w.vm as any).onRowContextMenu({
      row: { event_ID: 'evt1', cnt: 42 },
      x: 100, y: 200, rowIndex: 0,
    })
    await (w.vm as any).confirmDrilldown()
    expect(w.emitted('drilldown')).toBeTruthy()
    expect((w.emitted('drilldown')![0][0] as any).event_ID).toBe('evt1')
  })

  it('calls exportCsv when Export CSV button is clicked', async () => {
    const w = mount(ResultsTab, { props: baseProps })
    await w.find('[data-test="export-csv"]').trigger('click')
    await flushPromises()
    expect(exportSpy).toHaveBeenCalledWith(baseProps.generatedSql)
  })

  it('renders the drilldown menu in disabled state when canDrillDown is false', async () => {
    const w = mount(ResultsTab, {
      props: { ...baseProps, canDrillDown: () => false },
    })
    await (w.vm as any).onRowContextMenu({
      row: { event_ID: 'evt1', cnt: 42 },
      x: 50, y: 60, rowIndex: 0,
    })
    const drillBtn = w.find('.context-menu button:first-child')
    expect(drillBtn.attributes('disabled')).toBeDefined()
  })

  it('disables the chart toggle when no numeric/temporal column exists', () => {
    const stringOnlyResults = {
      ...baseProps.results,
      columns: ['name'],
      rows: [['Alice'], ['Bob']] as Array<Array<string | number | null>>,
    }
    const w = mount(ResultsTab, {
      props: { ...baseProps, results: stringOnlyResults as any },
    })
    const chartBtn = w.find('[data-test="results-view-chart"]')
    expect(chartBtn.attributes('disabled')).toBeDefined()
  })
})
