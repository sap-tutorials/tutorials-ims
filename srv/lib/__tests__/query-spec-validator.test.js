import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { validateQuerySpec } = require('../query-spec-validator.cjs')

// Schema-faithful fixture (verified against db/schema.cds + db/views.cds at write time):
//   - TaskRecords carries the FK columns user_ID, event_ID + status enum COMPLETED/IN_PROGRESS
//     + completionDate. This is what the chip builder joins through for any user-attribution query.
//   - Tasks is a UNION view (db/views.cds:5-39) over Tutorials/Missions/Groups/Steps/Checkpoints —
//     no FK columns and a different status enum (TaskStatus = ACTIVE/INACTIVE).
//   - Users has discrete name fields (firstName/lastName/displayName), not a fullName.
const VALID_ENTITIES = new Map([
  ['TaskRecords', { columns: new Map([
    ['ID',             { type: 'cds.UUID' }],
    ['status',         { type: 'cds.String' }],   // COMPLETED | IN_PROGRESS
    ['taskType',       { type: 'cds.String' }],
    ['completionDate', { type: 'cds.Timestamp' }],
    ['createdAt',      { type: 'cds.Timestamp' }],
    ['user_ID',        { type: 'cds.UUID' }],
    ['event_ID',       { type: 'cds.UUID' }],
  ]) }],
  ['Tasks',       { columns: new Map([
    ['ID',         { type: 'cds.UUID' }],
    ['status',     { type: 'cds.String' }],       // ACTIVE | INACTIVE
    ['taskType',   { type: 'cds.String' }],
    ['createdAt',  { type: 'cds.Timestamp' }],
    ['modifiedAt', { type: 'cds.Timestamp' }],
  ]) }],
  ['Users',       { columns: new Map([
    ['ID',          { type: 'cds.UUID' }],
    ['email',       { type: 'cds.String' }],
    ['displayName', { type: 'cds.String' }],
  ]) }],
])

describe('query-spec-validator', () => {
  const baseSpec = () => ({
    version: 1,
    from: { entity: 'TaskRecords', alias: 'tr' },
    joins: [],
    filterTree: null,
    groupBy: [],
    select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
    orderBy: [],
    limit: null,
  })

  it('accepts a minimal valid spec', () => {
    const r = validateQuerySpec(baseSpec(), VALID_ENTITIES)
    expect(r.errors).toEqual([])
  })

  it('rejects unknown entity in from', () => {
    const s = baseSpec(); s.from.entity = 'Nope'
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.message.match(/entity.*Nope/i))).toBe(true)
  })

  it('rejects ColumnRef referencing unknown alias', () => {
    const s = baseSpec(); s.select[0].ref.alias = 'x'
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 's1' && e.message.match(/alias.*x/i))).toBe(true)
  })

  it('rejects ColumnRef with unknown column on a known alias', () => {
    const s = baseSpec(); s.select[0].ref.column = 'nopeCol'
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 's1' && e.message.match(/column.*nopeCol/i))).toBe(true)
  })

  it('rejects "between" with non-range value', () => {
    const s = baseSpec()
    s.filterTree = { id: 'fg0', kind: 'group', conjunction: 'and', children: [
      { id: 'f1', ref: { alias: 'tr', column: 'createdAt' }, op: 'between',
        value: { kind: 'literal', value: '2026-01-01' } }
    ] }
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'f1' && e.message.match(/between.*range/i))).toBe(true)
  })

  it('rejects "in" with non-list value', () => {
    const s = baseSpec()
    s.filterTree = { id: 'fg0', kind: 'group', conjunction: 'and', children: [
      { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'in',
        value: { kind: 'literal', value: 'COMPLETED' } }
    ] }
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'f1' && e.message.match(/in.*list/i))).toBe(true)
  })

  it('rejects OR-group nested deeper than 4', () => {
    let inner = { id: 'leaf', ref: { alias: 'tr', column: 'ID' }, op: 'eq',
      value: { kind: 'literal', value: 'x' } }
    for (let i = 0; i < 5; i++) {
      inner = { id: 'g' + i, kind: 'group', conjunction: 'or', children: [inner] }
    }
    const s = baseSpec(); s.filterTree = inner
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.message.match(/depth/i))).toBe(true)
  })

  it('accepts a 2-table join with valid ON', () => {
    const s = baseSpec()
    s.joins = [{ id: 'j1', kind: 'inner',
      target: { entity: 'Users', alias: 'u' },
      on: { leftRef: {alias:'tr',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }]
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors).toEqual([])
  })

  it('rejects a join where ON references an unknown alias', () => {
    const s = baseSpec()
    s.joins = [{ id: 'j1', kind: 'inner',
      target: { entity: 'Users', alias: 'u' },
      on: { leftRef: {alias:'zz',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }]
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'j1' && e.message.match(/alias.*zz/i))).toBe(true)
  })

  it('rejects an aggregation chip with unknown function', () => {
    const s = baseSpec()
    s.select.push({ kind: 'aggregation', id: 's2', fn: 'STDEV', ref: '*' })
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 's2' && e.message.match(/STDEV|fn/i))).toBe(true)
  })

  it('rejects empty select array', () => {
    const s = baseSpec(); s.select = []
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.message.match(/select.*empty|at least one/i))).toBe(true)
  })

  it('rejects unsupported FilterOp for column type (between on String)', () => {
    const s = baseSpec()
    s.filterTree = { id: 'fg0', kind: 'group', conjunction: 'and', children: [
      { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'between',
        value: { kind: 'range', value: ['A', 'Z'] } }
    ] }
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'f1')).toBe(true)
  })
})
