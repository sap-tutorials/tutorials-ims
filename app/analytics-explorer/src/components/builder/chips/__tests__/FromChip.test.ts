// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FromChip from '../FromChip.vue'

describe('FromChip', () => {
  it('renders the entity name + alias in compact form', () => {
    const w = mount(FromChip, {
      props: {
        from: { entity: 'Tasks', alias: 't' },
        availableEntities: [
          { name: 'Tasks', label: 'Tasks' },
          { name: 'Users', label: 'Users' },
        ],
      },
    })
    expect(w.text()).toContain('Tasks')
    expect(w.text()).toContain('t')
  })

  it('emits change when applyChange is invoked with a new entity/alias pair', async () => {
    const w = mount(FromChip, {
      props: {
        from: { entity: 'Tasks', alias: 't' },
        availableEntities: [
          { name: 'Tasks', label: 'Tasks' },
          { name: 'Users', label: 'Users' },
        ],
      },
    })
    await (w.vm as any).applyChange({ entity: 'Users', alias: 'u' })
    expect(w.emitted('change')).toBeTruthy()
    expect(w.emitted('change')![0][0]).toEqual({ entity: 'Users', alias: 'u' })
  })

  it('does NOT emit change when applyChange is given the same entity/alias', async () => {
    const w = mount(FromChip, {
      props: {
        from: { entity: 'Tasks', alias: 't' },
        availableEntities: [{ name: 'Tasks', label: 'Tasks' }],
      },
    })
    await (w.vm as any).applyChange({ entity: 'Tasks', alias: 't' })
    expect(w.emitted('change')).toBeFalsy()
  })
})
