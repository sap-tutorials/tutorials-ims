// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const loadRowsSpy = vi.fn(async () => {})
const rowsRef = ref<any[]>([])
const lastErrorRef = ref<string | null>(null)
const isLoadingRef = ref(false)
const parseSpecSpy = vi.fn((s: string | null) => s ? JSON.parse(s) : null)

vi.mock('../../../composables/useHistory', () => ({
  useHistory: () => ({
    rows: rowsRef,
    isLoading: isLoadingRef,
    lastError: lastErrorRef,
    loadRows: loadRowsSpy,
    parseSpec: parseSpecSpy,
  }),
}))

import HistoryTab from '../HistoryTab.vue'

describe('HistoryTab', () => {
  beforeEach(() => {
    loadRowsSpy.mockClear()
    rowsRef.value = []
    lastErrorRef.value = null
    isLoadingRef.value = false
  })

  it('calls loadRows on mount', () => {
    mount(HistoryTab)
    expect(loadRowsSpy).toHaveBeenCalled()
  })

  it('renders the rows with sql preview + timestamp', async () => {
    rowsRef.value = [
      { ID: 'h1', sql: 'SELECT id FROM Users LIMIT 10', spec: null, createdAt: '2026-05-30T10:00:00Z', source: 'editor', rowCount: 10, durationMs: 50, truncated: false, privacyMode: 'raw' },
    ]
    const w = mount(HistoryTab)
    await flushPromises()
    expect(w.text()).toContain('SELECT id FROM Users')
    expect(w.text()).toContain('editor')
    expect(w.text().toLowerCase()).toContain('rows')
  })

  it('emits load with the row when Load button is clicked', async () => {
    const r = { ID: 'h1', sql: 'SELECT 1', spec: '{"version":1}', createdAt: '2026-05-30T10:00:00Z', source: 'builder', rowCount: 1, durationMs: 10, truncated: false, privacyMode: 'raw' }
    rowsRef.value = [r]
    const w = mount(HistoryTab)
    await flushPromises()
    await w.find('[data-test="history-load"]').trigger('click')
    expect(w.emitted('load')).toBeTruthy()
    expect(w.emitted('load')![0][0]).toStrictEqual(r)
  })

  it('renders the empty state when no rows', () => {
    rowsRef.value = []
    const w = mount(HistoryTab)
    expect(w.text().toLowerCase()).toContain('no history')
  })

  it('renders an error message when lastError is set', () => {
    lastErrorRef.value = 'fetch broken'
    const w = mount(HistoryTab)
    expect(w.text()).toContain('fetch broken')
  })
})
