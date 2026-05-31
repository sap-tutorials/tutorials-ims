// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FilterChip from '../FilterChip.vue'
import type { Filter } from '../../../../types/query-spec'

const enumFilter: Filter = {
  id: 'f1',
  ref: { alias: 't', column: 'status' },
  op: 'in',
  value: { kind: 'list', value: ['PENDING', 'IN_PROGRESS'] },
}

const dateFilter: Filter = {
  id: 'f2',
  ref: { alias: 't', column: 'createdAt' },
  op: 'sinceDays',
  value: { kind: 'relative', value: 30 },
}

const stubAliasMap = new Map([
  ['t', { columns: new Map([
    ['status', { type: 'cds.String', filterMode: 'enum', filterSample: true } as any],
    ['createdAt', { type: 'cds.Timestamp', filterMode: 'date' } as any],
    ['title', { type: 'cds.String', filterMode: 'free' } as any],
  ])}],
])

const stubSampleDistinct = async () => ({
  values: ['PENDING', 'IN_PROGRESS', 'DONE'],
  truncated: false,
})

describe('FilterChip', () => {
  it('renders compact form for an enum-mode IN filter', () => {
    const w = mount(FilterChip, {
      props: { filter: enumFilter, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct },
    })
    expect(w.text()).toContain('t.status')
    expect(w.text()).toContain('IN')
    expect(w.text()).toContain('PENDING')
  })

  it('renders compact form for a date-mode sinceDays filter', () => {
    const w = mount(FilterChip, {
      props: { filter: dateFilter, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct },
    })
    expect(w.text()).toContain('t.createdAt')
    expect(w.text().toLowerCase()).toContain('since')
  })

  it('emits change when applyChange is invoked', async () => {
    const w = mount(FilterChip, {
      props: { filter: enumFilter, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct },
    })
    const next: Filter = { ...enumFilter, value: { kind: 'list', value: ['PENDING'] } }
    await (w.vm as any).applyChange(next)
    expect(w.emitted('change')).toBeTruthy()
    expect((w.emitted('change')![0][0] as Filter).value).toEqual({ kind: 'list', value: ['PENDING'] })
  })

  it('emits remove when removeChip is invoked', async () => {
    const w = mount(FilterChip, {
      props: { filter: enumFilter, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct },
    })
    await (w.vm as any).removeChip()
    expect(w.emitted('remove')).toBeTruthy()
  })

  it('exposes the filterMode-by-op compatibility table for a column', () => {
    const w = mount(FilterChip, {
      props: { filter: enumFilter, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct },
    })
    // For an enum-mode column, allowed ops should be eq/neq/in/isNull (no contains).
    const ops = (w.vm as any).availableOps as string[]
    expect(ops).toContain('eq')
    expect(ops).toContain('in')
    expect(ops).not.toContain('contains')
  })

  it('exposes free-mode ops without "in"', () => {
    const titleFilter: Filter = {
      id: 'f3',
      ref: { alias: 't', column: 'title' },
      op: 'contains',
      value: { kind: 'literal', value: 'foo' },
    }
    const w = mount(FilterChip, {
      props: { filter: titleFilter, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct },
    })
    const ops = (w.vm as any).availableOps as string[]
    expect(ops).toContain('contains')
    expect(ops).toContain('startsWith')
    expect(ops).not.toContain('in')   // 'in' suppressed for free-text per spec
  })
})
