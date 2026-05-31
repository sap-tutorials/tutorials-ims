// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const saveAsSpy = vi.fn(async (input: any) => ({ ID: 'new', ...input }))
vi.mock('../../../composables/useSavedQueries', () => ({
  useSavedQueries: () => ({
    saveAs: saveAsSpy,
  }),
}))

const specRef = ref<any>(null)
vi.mock('../../../composables/useQuerySpec', () => ({
  useQuerySpec: () => ({ spec: specRef }),
}))

const sqlNamesRef = ref<Record<string, string>>({})
vi.mock('../../../composables/useEntityGraph', () => ({
  useEntityGraph: () => ({ sqlNames: sqlNamesRef }),
}))

vi.mock('@srv-lib/spec-to-sql.mjs', () => ({
  specToSql: () => 'SELECT 1',
}))

import BuilderHeader from '../BuilderHeader.vue'

describe('BuilderHeader', () => {
  beforeEach(() => {
    saveAsSpy.mockClear()
    specRef.value = null
  })

  it('renders the empty state when no spec', () => {
    specRef.value = null
    const w = mount(BuilderHeader)
    expect(w.text()).toContain('No query yet')
  })

  it('renders query title and Save button when spec exists', () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    expect(w.text()).toContain('Tasks')
    expect(w.find('[data-test="save-query"]').exists()).toBe(true)
  })

  it('opens the SaveQueryDialog on Save click', async () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    expect((w.vm as any).dialogOpen).toBe(false)
    await w.find('[data-test="save-query"]').trigger('click')
    expect((w.vm as any).dialogOpen).toBe(true)
  })

  it('onDialogSave calls saveAs with name/description/visibility/sql/spec', async () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    await (w.vm as any).onDialogSave({ name: 'X', description: 'd', visibility: 'private' })
    await flushPromises()
    expect(saveAsSpy).toHaveBeenCalled()
    const arg = saveAsSpy.mock.calls[0][0]
    expect(arg.name).toBe('X')
    expect(arg.description).toBe('d')
    expect(arg.visibility).toBe('private')
    expect(arg.sql).toBe('SELECT 1')
    expect(arg.spec).toBe(JSON.stringify(specRef.value))
  })

  it('emits "saved" event after successful save', async () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    await (w.vm as any).onDialogSave({ name: 'X', description: '', visibility: 'private' })
    await flushPromises()
    expect(w.emitted('saved')).toBeTruthy()
  })
})
