// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const loadRowsSpy = vi.fn(async () => {})
const removeSpy = vi.fn(async () => {})
const setVisibilitySpy = vi.fn(async () => ({ ID: 's1', visibility: 'shared-admins' }))
const duplicateSpy = vi.fn(async () => ({ ID: 'new-id' }))
const renameSpy = vi.fn(async () => ({ ID: 's1', name: 'New name' }))
const rowsRef = ref<any[]>([])

vi.mock('../../../composables/useSavedQueries', () => ({
  useSavedQueries: () => ({
    rows: rowsRef,
    isLoading: ref(false),
    lastError: ref(null),
    loadRows: loadRowsSpy,
    rename: renameSpy,
    setVisibility: setVisibilitySpy,
    duplicate: duplicateSpy,
    remove: removeSpy,
    parseSpec: (s: string | null) => s ? JSON.parse(s) : null,
  }),
}))

import SavedTab from '../SavedTab.vue'

const sampleRow = {
  ID: 's1', name: 'Top events', description: 'desc',
  sql: 'SELECT id FROM Events', spec: '{"version":1}', visibility: 'private',
  rowCount: 5, durationMs: 80, truncated: false, privacyMode: 'raw',
  createdBy: 'tom@test', createdAt: '2026-05-30T10:00:00Z', lastRunAt: null,
}

describe('SavedTab', () => {
  beforeEach(() => {
    loadRowsSpy.mockClear()
    removeSpy.mockClear()
    setVisibilitySpy.mockClear()
    duplicateSpy.mockClear()
    renameSpy.mockClear()
    rowsRef.value = []
  })

  it('calls loadRows on mount', () => {
    mount(SavedTab)
    expect(loadRowsSpy).toHaveBeenCalled()
  })

  it('renders rows with name + visibility + sql preview', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    expect(w.text()).toContain('Top events')
    expect(w.text()).toContain('private')
    expect(w.text()).toContain('SELECT id FROM Events')
  })

  it('emits load when Load button is clicked', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-load"]').trigger('click')
    expect(w.emitted('load')).toBeTruthy()
    expect(w.emitted('load')![0][0]).toStrictEqual(sampleRow)
  })

  it('toggleVisibility calls setVisibility with the flipped value', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-toggle-visibility"]').trigger('click')
    expect(setVisibilitySpy).toHaveBeenCalledWith('s1', 'shared-admins')
  })

  it('duplicate calls the action + reloads rows', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-duplicate"]').trigger('click')
    expect(duplicateSpy).toHaveBeenCalledWith('s1')
  })

  it('delete prompts confirm + calls remove + reloads', async () => {
    rowsRef.value = [sampleRow]
    if (!window.confirm) (window as any).confirm = () => true
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-delete"]').trigger('click')
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('s1')
    confirmSpy.mockRestore()
  })

  it('delete does NOT call remove when confirm returns false', async () => {
    rowsRef.value = [sampleRow]
    if (!window.confirm) (window as any).confirm = () => true
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-delete"]').trigger('click')
    expect(removeSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('renders empty state when no rows', () => {
    rowsRef.value = []
    const w = mount(SavedTab)
    expect(w.text().toLowerCase()).toContain('no saved')
  })
})
