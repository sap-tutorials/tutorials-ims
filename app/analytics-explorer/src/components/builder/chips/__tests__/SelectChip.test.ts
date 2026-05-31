// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SelectChip from '../SelectChip.vue'
import type { SelectItem } from '../../../../types/query-spec'

const stubAliasMap = new Map([
  ['t', { columns: new Map([
    ['status', { type: 'cds.String' } as any],
    ['amount', { type: 'cds.Decimal' } as any],
  ])}],
])

const colItem: SelectItem = { kind: 'column', id: 's1', ref: { alias: 't', column: 'status' } }
const aggItem: SelectItem = { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' }
const exprItem: SelectItem = {
  kind: 'expression', id: 's3', sql: 'YEAR(t.createdAt)', alias: 'year', referencedAliases: ['t'],
}

describe('SelectChip', () => {
  it('renders compact form for a column item', () => {
    const w = mount(SelectChip, {
      props: { item: colItem, aliasMap: stubAliasMap },
    })
    expect(w.text()).toContain('t.status')
  })

  it('renders compact form for an aggregation', () => {
    const w = mount(SelectChip, {
      props: { item: aggItem, aliasMap: stubAliasMap },
    })
    expect(w.text()).toContain('COUNT(*)')
    expect(w.text()).toContain('cnt')
  })

  it('renders expression with the f marker', () => {
    const w = mount(SelectChip, {
      props: { item: exprItem, aliasMap: stubAliasMap },
    })
    expect(w.text()).toContain('YEAR(t.createdAt)')
    expect(w.text()).toContain('year')
  })

  it('emits change when applyChange is invoked', async () => {
    const w = mount(SelectChip, {
      props: { item: colItem, aliasMap: stubAliasMap },
    })
    const next: SelectItem = { kind: 'column', id: 's1', ref: { alias: 't', column: 'amount' }, alias: 'a' }
    await (w.vm as any).applyChange(next)
    expect(w.emitted('change')).toBeTruthy()
  })

  it('emits remove when removeChip is called', async () => {
    const w = mount(SelectChip, {
      props: { item: colItem, aliasMap: stubAliasMap },
    })
    await (w.vm as any).removeChip()
    expect(w.emitted('remove')).toBeTruthy()
  })
})
