// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultsTable from '../ResultsTable.vue'

describe('ResultsTable', () => {
  it('renders the column headers', () => {
    const w = mount(ResultsTable, {
      props: {
        columns: ['event_ID', 'cnt'],
        rows: [['evt1', 42], ['evt2', 17]],
      },
    })
    expect(w.text()).toContain('event_ID')
    expect(w.text()).toContain('cnt')
  })

  it('renders an empty-state message when rows is empty', () => {
    const w = mount(ResultsTable, {
      props: { columns: ['x'], rows: [] },
    })
    expect(w.text().toLowerCase()).toContain('no rows')
  })

  it('formats null cells as ∅ via fmt helper', () => {
    // RecycleScroller doesn't render slot items in happy-dom (no layout = no
    // virtualization), so we test the formatter directly via the exposed helper.
    const w = mount(ResultsTable, {
      props: { columns: ['x', 'y'], rows: [[null, 'value']] },
    })
    expect((w.vm as any).fmt(null)).toBe('∅')
    expect((w.vm as any).fmt('value')).toBe('value')
    expect((w.vm as any).fmt(42)).toBe('42')
  })

  it('emits row-context-menu on right-click with row + screen position', async () => {
    const w = mount(ResultsTable, {
      props: {
        columns: ['event_ID', 'cnt'],
        rows: [['evt1', 42]],
      },
    })
    // Simulate right-click via the exposed test helper. Right-clicking a real
    // <tr> through happy-dom's contextmenu event is finicky; the component
    // exposes onRowContextMenu(cells, event, rowIndex) for direct invocation.
    await (w.vm as any).onRowContextMenu(
      ['evt1', 42],
      { clientX: 100, clientY: 200, preventDefault: () => {} },
      0,
    )
    const emitted = w.emitted('row-context-menu')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as any
    expect(payload.row).toEqual({ event_ID: 'evt1', cnt: 42 })
    expect(payload.x).toBe(100)
    expect(payload.y).toBe(200)
  })
})
