// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JoinChip from '../JoinChip.vue'
import type { Join } from '../../../../types/query-spec'

const baseJoin: Join = {
  id: 'j1',
  kind: 'inner',
  target: { entity: 'Users', alias: 'u' },
  on: {
    leftRef: { alias: 't', column: 'user_ID' },
    rightRef: { alias: 'u', column: 'ID' },
  },
}

describe('JoinChip', () => {
  it('renders compact form INNER JOIN Users (u) ON t.user_ID = u.ID', () => {
    const w = mount(JoinChip, {
      props: {
        join: baseJoin,
        availableEntities: [{ name: 'Tasks', label: 'Tasks' }, { name: 'Users', label: 'Users' }],
        suggestions: [],
        existingAliases: ['t'],
      },
    })
    expect(w.text()).toContain('INNER JOIN')
    expect(w.text()).toContain('Users')
    expect(w.text()).toContain('u')
    expect(w.text()).toContain('t.user_ID')
    expect(w.text()).toContain('u.ID')
  })

  it('emits change on applyChange with a new join shape', async () => {
    const w = mount(JoinChip, {
      props: {
        join: baseJoin,
        availableEntities: [{ name: 'Tasks', label: 'Tasks' }, { name: 'Users', label: 'Users' }],
        suggestions: [],
        existingAliases: ['t'],
      },
    })
    const next: Join = {
      ...baseJoin,
      kind: 'left',
    }
    await (w.vm as any).applyChange(next)
    expect(w.emitted('change')).toBeTruthy()
    expect(w.emitted('change')![0][0]).toEqual(next)
  })

  it('emits remove when removeChip is invoked', async () => {
    const w = mount(JoinChip, {
      props: {
        join: baseJoin,
        availableEntities: [{ name: 'Tasks', label: 'Tasks' }, { name: 'Users', label: 'Users' }],
        suggestions: [],
        existingAliases: ['t'],
      },
    })
    await (w.vm as any).removeChip()
    expect(w.emitted('remove')).toBeTruthy()
  })
})
