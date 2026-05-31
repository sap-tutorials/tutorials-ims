import { describe, it, expect } from 'vitest'
import { deriveDrilldownSpec, canDrillDown } from '../derive-drilldown'
import type { QuerySpec } from '../../types/query-spec'

const groupedSpec = (): QuerySpec => ({
  version: 1,
  from: { entity: 'TaskRecords', alias: 'tr' },
  joins: [],
  filterTree: null,
  groupBy: [],
  select: [
    { kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' } },
    { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
  ],
  orderBy: [],
  limit: null,
})

describe('canDrillDown', () => {
  it('returns true for an aggregated spec with no expression chips', () => {
    expect(canDrillDown(groupedSpec(), { event_ID: 'evt1', cnt: 42 })).toBe(true)
  })

  it('returns false when no aggregation chip is present (already raw)', () => {
    const s = groupedSpec()
    s.select = [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' } }]
    expect(canDrillDown(s, { event_ID: 'evt1' })).toBe(false)
  })

  it('returns false when the spec has an expression chip', () => {
    const s = groupedSpec()
    s.select.push({ kind: 'expression', id: 's3', sql: 'YEAR(tr.createdAt)', alias: 'y', referencedAliases: ['tr'] })
    expect(canDrillDown(s, { event_ID: 'evt1', cnt: 42, y: 2026 })).toBe(false)
  })

  it('returns false when a non-aggregation column is NULL in the row', () => {
    expect(canDrillDown(groupedSpec(), { event_ID: null, cnt: 42 })).toBe(false)
  })
})

describe('deriveDrilldownSpec', () => {
  it('strips aggregations + adds equality filter for non-agg columns', () => {
    const drill = deriveDrilldownSpec(groupedSpec(), { event_ID: 'evt1', cnt: 42 })!
    // Aggregation chip removed
    expect(drill.select.every(s => s.kind !== 'aggregation')).toBe(true)
    expect(drill.select.length).toBe(1)
    expect(drill.select[0]).toMatchObject({ kind: 'column', ref: { alias: 'tr', column: 'event_ID' } })
    // Equality filter added
    expect(drill.filterTree).toBeTruthy()
    expect(drill.filterTree!.kind).toBe('group')
    const grp = drill.filterTree as any
    expect(grp.children).toHaveLength(1)
    expect(grp.children[0]).toMatchObject({
      ref: { alias: 'tr', column: 'event_ID' },
      op: 'eq',
      value: { kind: 'literal', value: 'evt1' },
    })
  })

  it('sets fresh LIMIT 200 (drill is for inspection, not export)', () => {
    const drill = deriveDrilldownSpec(groupedSpec(), { event_ID: 'evt1', cnt: 42 })!
    expect(drill.limit).toBe(200)
  })

  it('clears explicit groupBy', () => {
    const s = groupedSpec()
    s.groupBy = [{ id: 'g1', ref: { alias: 'tr', column: 'taskType' } }]
    const drill = deriveDrilldownSpec(s, { event_ID: 'evt1', cnt: 42 })!
    expect(drill.groupBy).toEqual([])
  })

  it('preserves joins in the drill spec', () => {
    const s = groupedSpec()
    s.joins = [{
      id: 'j1', kind: 'inner',
      target: { entity: 'Users', alias: 'u' },
      on: { leftRef: { alias: 'tr', column: 'user_ID' }, rightRef: { alias: 'u', column: 'ID' } },
    }]
    const drill = deriveDrilldownSpec(s, { event_ID: 'evt1', cnt: 42 })!
    expect(drill.joins).toHaveLength(1)
  })

  it('returns null when canDrillDown is false', () => {
    const s = groupedSpec()
    s.select = [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' } }]
    expect(deriveDrilldownSpec(s, { event_ID: 'evt1' })).toBe(null)
  })

  it('uses output alias as the row-key lookup when SELECT chip has alias', () => {
    // When a SELECT chip has alias 'eid', the result row uses key 'eid' not 'event_ID'.
    const s = groupedSpec()
    s.select[0] = { kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' }, alias: 'eid' }
    const drill = deriveDrilldownSpec(s, { eid: 'evt1', cnt: 42 })!
    const grp = drill.filterTree as any
    expect(grp.children[0].value.value).toBe('evt1')
  })
})
