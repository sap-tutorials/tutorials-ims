// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SaveQueryDialog from '../SaveQueryDialog.vue'

describe('SaveQueryDialog', () => {
  it('renders the dialog when open=true', () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    // ui5-dialog's header-text attribute isn't surfaced by happy-dom .text(),
    // so check for the form fields instead.
    expect(w.text()).toContain('Name')
    expect(w.text()).toContain('Visibility')
  })

  it('does not render when open=false', () => {
    const w = mount(SaveQueryDialog, { props: { open: false } })
    // v-if="open" wraps the entire dialog — when closed, none of the form
    // fields render.
    expect(w.text()).not.toContain('Name')
    expect(w.text()).not.toContain('Visibility')
  })

  it('emits save with the form values when onSave called + name is non-empty', async () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    ;(w.vm as any).draftName = 'My query'
    ;(w.vm as any).draftDescription = 'desc'
    ;(w.vm as any).draftVisibility = 'shared-admins'
    await (w.vm as any).onSave()
    expect(w.emitted('save')).toBeTruthy()
    expect(w.emitted('save')![0][0]).toEqual({
      name: 'My query', description: 'desc', visibility: 'shared-admins',
    })
  })

  it('does NOT emit save when name is empty', async () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    ;(w.vm as any).draftName = ''
    await (w.vm as any).onSave()
    expect(w.emitted('save')).toBeFalsy()
  })

  it('emits cancel when onCancel called', async () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    await (w.vm as any).onCancel()
    expect(w.emitted('cancel')).toBeTruthy()
  })
})
