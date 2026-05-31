import { describe, it, expect, beforeEach } from 'vitest'
import { useQuerySpec } from '../useQuerySpec'
import type { QuerySpec } from '../../types/query-spec'

const baseSpec = (): QuerySpec => ({
  version: 1,
  from: { entity: 'Tasks', alias: 't' },
  joins: [],
  filterTree: null,
  groupBy: [],
  select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'status' } }],
  orderBy: [],
  limit: null,
})

describe('useQuerySpec', () => {
  let store: ReturnType<typeof useQuerySpec>

  beforeEach(() => {
    store = useQuerySpec()
    store.clearSpec()  // singleton across tests; reset via clearSpec()
  })

  it('starts with a null spec (empty builder)', () => {
    expect(store.spec.value).toBe(null)
  })

  it('setSpec replaces the spec', () => {
    const s = baseSpec()
    store.setSpec(s)
    expect(store.spec.value).toEqual(s)
  })

  it('clearSpec resets to null', () => {
    store.setSpec(baseSpec())
    store.clearSpec()
    expect(store.spec.value).toBe(null)
  })

  it('setSpec defensively clones (mutating input does not leak)', () => {
    const s = baseSpec()
    store.setSpec(s)
    s.limit = 999
    expect(store.spec.value?.limit).toBe(null)
  })

  it('drilldown stack: push, pop, depth-1 cap', () => {
    const grouped = baseSpec()
    grouped.select.push({ kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' })
    store.setSpec(grouped)

    const drillSpec = baseSpec()
    drillSpec.filterTree = {
      id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq', value: { kind: 'literal', value: 'PENDING' } },
      ],
    }
    store.pushDrilldown(drillSpec)

    expect(store.spec.value?.filterTree).toBeTruthy()
    expect(store.isDrilldown.value).toBe(true)

    // Drilling from a drilldown REPLACES the current drilldown (depth-1 cap).
    const drill2 = baseSpec()
    drill2.limit = 50
    store.pushDrilldown(drill2)
    expect(store.spec.value?.limit).toBe(50)
    expect(store.isDrilldown.value).toBe(true)

    // Pop returns to the original grouped query.
    store.popDrilldown()
    expect(store.spec.value).toEqual(grouped)
    expect(store.isDrilldown.value).toBe(false)
  })

  it('mode toggle: builder | editor', () => {
    expect(store.mode.value).toBe('builder')
    store.takeOverFromBuilder()
    expect(store.mode.value).toBe('editor')
    store.returnToBuilder()
    expect(store.mode.value).toBe('builder')
  })
})
