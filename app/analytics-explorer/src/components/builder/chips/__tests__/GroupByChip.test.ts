// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GroupByChip from '../GroupByChip.vue'

describe('GroupByChip', () => {
  it('renders compact form for an explicit chip', () => {
    const w = mount(GroupByChip, {
      props: {
        chipKey: { id: 'g1', ref: { alias: 't', column: 'event_ID' }, auto: false },
        aliasMap: new Map(),
      },
    })
    expect(w.text()).toContain('t.event_ID')
    expect(w.text().toLowerCase()).not.toContain('auto')
  })

  it('renders (auto) marker for auto-derived chips', () => {
    const w = mount(GroupByChip, {
      props: {
        chipKey: { id: 'g-auto-t-status', ref: { alias: 't', column: 'status' }, auto: true },
        aliasMap: new Map(),
      },
    })
    expect(w.text().toLowerCase()).toContain('auto')
  })

  it('emits change when applyChange is invoked (explicit chip)', async () => {
    const w = mount(GroupByChip, {
      props: {
        chipKey: { id: 'g1', ref: { alias: 't', column: 'event_ID' }, auto: false },
        aliasMap: new Map(),
      },
    })
    const next = { id: 'g1', ref: { alias: 't', column: 'taskType' }, auto: false }
    await (w.vm as any).applyChange(next)
    expect(w.emitted('change')).toBeTruthy()
  })

  it('does NOT emit change/remove for auto-derived chips', async () => {
    const w = mount(GroupByChip, {
      props: {
        chipKey: { id: 'g-auto', ref: { alias: 't', column: 'status' }, auto: true },
        aliasMap: new Map(),
      },
    })
    // Auto chips block edit/remove operations.
    await (w.vm as any).applyChange({ id: 'g-auto', ref: { alias: 't', column: 'foo' }, auto: true })
    await (w.vm as any).removeChip()
    expect(w.emitted('change')).toBeFalsy()
    expect(w.emitted('remove')).toBeFalsy()
  })
})
