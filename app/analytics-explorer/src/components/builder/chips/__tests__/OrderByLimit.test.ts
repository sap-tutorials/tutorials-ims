// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import OrderByChip from '../OrderByChip.vue'
import LimitChip from '../LimitChip.vue'
import type { OrderClause, SelectItem } from '../../../../types/query-spec'

const stubAliasMap = new Map([
  ['t', { columns: new Map([['createdAt', { type: 'cds.Timestamp' } as any]]) }],
])

describe('OrderByChip', () => {
  it('renders selectId-based ordering', () => {
    const order: OrderClause = {
      id: 'o1',
      by: { kind: 'selectId', id: 's2' },
      direction: 'desc',
    }
    const selectItems: SelectItem[] = [
      { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
    ]
    const w = mount(OrderByChip, {
      props: { order, selectItems, aliasMap: stubAliasMap },
    })
    expect(w.text()).toContain('cnt')
    expect(w.text().toUpperCase()).toContain('DESC')
  })

  it('renders columnRef-based ordering', () => {
    const order: OrderClause = {
      id: 'o1',
      by: { kind: 'columnRef', ref: { alias: 't', column: 'createdAt' } },
      direction: 'asc',
    }
    const w = mount(OrderByChip, {
      props: { order, selectItems: [], aliasMap: stubAliasMap },
    })
    expect(w.text()).toContain('t.createdAt')
    expect(w.text().toUpperCase()).toContain('ASC')
  })

  it('emits change on applyChange', async () => {
    const order: OrderClause = {
      id: 'o1', by: { kind: 'columnRef', ref: { alias: 't', column: 'createdAt' } }, direction: 'asc',
    }
    const w = mount(OrderByChip, {
      props: { order, selectItems: [], aliasMap: stubAliasMap },
    })
    const next: OrderClause = { ...order, direction: 'desc' }
    await (w.vm as any).applyChange(next)
    expect(w.emitted('change')).toBeTruthy()
    expect((w.emitted('change')![0][0] as OrderClause).direction).toBe('desc')
  })

  it('emits remove', async () => {
    const order: OrderClause = {
      id: 'o1', by: { kind: 'columnRef', ref: { alias: 't', column: 'createdAt' } }, direction: 'asc',
    }
    const w = mount(OrderByChip, {
      props: { order, selectItems: [], aliasMap: stubAliasMap },
    })
    await (w.vm as any).removeChip()
    expect(w.emitted('remove')).toBeTruthy()
  })
})

describe('LimitChip', () => {
  it('renders LIMIT 10', () => {
    const w = mount(LimitChip, { props: { limit: 10 } })
    expect(w.text()).toContain('LIMIT')
    expect(w.text()).toContain('10')
  })

  it('renders server-cap text when limit is null', () => {
    const w = mount(LimitChip, { props: { limit: null } })
    expect(w.text().toLowerCase()).toContain('server cap')
  })

  it('emits change on applyChange', async () => {
    const w = mount(LimitChip, { props: { limit: 10 } })
    await (w.vm as any).applyChange(50)
    expect(w.emitted('change')).toBeTruthy()
    expect(w.emitted('change')![0][0]).toBe(50)
  })

  it('emits change with null when "use server cap" toggled', async () => {
    const w = mount(LimitChip, { props: { limit: 10 } })
    await (w.vm as any).applyChange(null)
    expect(w.emitted('change')![0][0]).toBe(null)
  })
})
