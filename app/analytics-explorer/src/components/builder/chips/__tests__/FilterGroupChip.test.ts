// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FilterGroupChip from '../FilterGroupChip.vue'
import type { FilterGroup, Filter } from '../../../../types/query-spec'

const leaf = (id: string, col: string): Filter => ({
  id,
  ref: { alias: 't', column: col },
  op: 'eq',
  value: { kind: 'literal', value: 'X' },
})

const flatGroup = (): FilterGroup => ({
  id: 'fg',
  kind: 'group',
  conjunction: 'and',
  children: [leaf('f1', 'status'), leaf('f2', 'taskType')],
})

const stubAliasMap = new Map([
  ['t', { columns: new Map([
    ['status',   { type: 'cds.String', filterMode: 'enum', filterSample: false } as any],
    ['taskType', { type: 'cds.String', filterMode: 'enum', filterSample: false } as any],
  ])}],
])

const stubSampleDistinct = async () => ({ values: [], truncated: false })

describe('FilterGroupChip', () => {
  it('renders open and close brackets', () => {
    const w = mount(FilterGroupChip, {
      props: {
        group: flatGroup(),
        aliasMap: stubAliasMap,
        sampleDistinctCached: stubSampleDistinct,
        depth: 1,
      },
    })
    expect(w.text()).toContain('(')
    expect(w.text()).toContain(')')
  })

  it('renders an AND token between two children', () => {
    const w = mount(FilterGroupChip, {
      props: {
        group: flatGroup(),
        aliasMap: stubAliasMap,
        sampleDistinctCached: stubSampleDistinct,
        depth: 1,
      },
    })
    expect(w.text()).toContain('AND')
  })

  it('renders OR when conjunction is or', () => {
    const w = mount(FilterGroupChip, {
      props: {
        group: { ...flatGroup(), conjunction: 'or' },
        aliasMap: stubAliasMap,
        sampleDistinctCached: stubSampleDistinct,
        depth: 1,
      },
    })
    expect(w.text()).toContain('OR')
  })

  it('emits change with toggled conjunction', async () => {
    const g = flatGroup()
    const w = mount(FilterGroupChip, {
      props: { group: g, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct, depth: 1 },
    })
    await (w.vm as any).toggleConjunction()
    const emitted = w.emitted('change')
    expect(emitted).toBeTruthy()
    expect((emitted![0][0] as FilterGroup).conjunction).toBe('or')
  })

  it('emits change with the child removed when a child remove is forwarded', async () => {
    const g = flatGroup()
    const w = mount(FilterGroupChip, {
      props: { group: g, aliasMap: stubAliasMap, sampleDistinctCached: stubSampleDistinct, depth: 1 },
    })
    await (w.vm as any).removeChild('f1')
    expect(w.emitted('change')).toBeTruthy()
    const next = w.emitted('change')![0][0] as FilterGroup
    expect(next.children.length).toBe(1)
    expect(next.children[0].id).toBe('f2')
  })

  it('disables add-nested-group at depth >= 4', () => {
    const w = mount(FilterGroupChip, {
      props: {
        group: flatGroup(),
        aliasMap: stubAliasMap,
        sampleDistinctCached: stubSampleDistinct,
        depth: 4,
      },
    })
    expect((w.vm as any).canAddNestedGroup).toBe(false)
  })

  it('emits remove when removeChip is called', async () => {
    const w = mount(FilterGroupChip, {
      props: {
        group: flatGroup(),
        aliasMap: stubAliasMap,
        sampleDistinctCached: stubSampleDistinct,
        depth: 1,
      },
    })
    await (w.vm as any).removeChip()
    expect(w.emitted('remove')).toBeTruthy()
  })
})
