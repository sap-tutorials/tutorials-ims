import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { specToSql } = require('../spec-to-sql.cjs')

const SQL_NAMES = { Tasks: 'TASKS', Users: 'USERS' }

describe('spec-to-sql', () => {
  it('emits a minimal single-table SELECT', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [], filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/^SELECT\s+t\.id\s+FROM\s+TASKS\s+t\s*$/)
  })

  it('quotes string literals in eq filters and uses parens around tree', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: 'PENDING' } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("WHERE (t.status = 'PENDING')")
  })

  it('escapes single quotes in string literals', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: "O'Brien" } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("'O''Brien'")
  })

  it('rejects raw single-quote injection attempts via list values', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'in',
          value: { kind: 'list', value: ["x'; DROP TABLE Tasks; --"] } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    // Escaped: doubled single quote inside the literal — SQL sees it as a
    // single string ending in --, never breaks out of the quoted context.
    expect(sql).toContain("'x''; DROP TABLE Tasks; --'")
    // The injection attempt would have produced an UN-escaped break-out
    // pattern: "x'; DROP TABLE Tasks; --". The escaped output must not
    // contain that exact substring (without the doubled quote).
    expect(sql).not.toMatch(/[^']'; DROP TABLE Tasks/)
  })

  it('emits OR group with proper parens and AND default at top', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: 'PENDING' } },
        { id: 'fg2', kind: 'group', conjunction: 'or', children: [
          { id: 'f2', ref: { alias: 't', column: 'taskType' }, op: 'eq',
            value: { kind: 'literal', value: 'A' } },
          { id: 'f3', ref: { alias: 't', column: 'taskType' }, op: 'eq',
            value: { kind: 'literal', value: 'B' } },
        ] }
      ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/WHERE \(t\.status = 'PENDING' AND \(t\.taskType = 'A' OR t\.taskType = 'B'\)\)/)
  })

  it('emits INNER JOIN with ON', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [{ id: 'j1', kind: 'inner', target: { entity: 'Users', alias: 'u' },
        on: { leftRef: {alias:'t',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }],
      filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain('INNER JOIN USERS u ON t.user_ID = u.ID')
  })

  it('auto-derives GROUP BY from non-aggregation SELECT chips when an aggregation is present', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 't', column: 'status' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
      ],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain('GROUP BY t.status')
    expect(sql).toMatch(/SELECT t\.status, COUNT\(\*\) AS cnt/)
  })

  it('does not emit GROUP BY when no aggregation present', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column', id: 's1', ref: { alias: 't', column: 'status' } },
        { kind: 'column', id: 's2', ref: { alias: 't', column: 'id' } },
      ],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).not.toContain('GROUP BY')
  })

  it('orders by selectId alias and supports asc/desc', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 't', column: 'status' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
      ],
      orderBy: [{ id:'o1', by: { kind: 'selectId', id: 's2' }, direction: 'desc' }],
      limit: 10,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/ORDER BY cnt DESC/)
    expect(sql).toMatch(/LIMIT 10\s*$/)
  })

  it('emits sinceDays as ADD_DAYS expression', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'createdAt' }, op: 'sinceDays',
          value: { kind: 'relative', value: 30 } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/t\.createdAt >= ADD_DAYS\(CURRENT_DATE,\s*-30\)/)
  })

  it('produces SQL that passes analytics-sql-validator', () => {
    const { validateSelect } = require('../analytics-sql-validator.cjs')
    const ALLOWED = new Set(['TASKS', 'USERS', 'Tasks', 'Users'])
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [{ id: 'j1', kind: 'inner', target: { entity: 'Users', alias: 'u' },
        on: { leftRef: {alias:'t',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'in',
          value: { kind: 'list', value: ['PENDING', 'IN_PROGRESS'] } } ] },
      groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 't', column: 'event_ID' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'task_count' },
      ],
      orderBy: [{ id:'o1', by: { kind: 'selectId', id: 's2' }, direction: 'desc' }],
      limit: 10,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(() => validateSelect(sql, ALLOWED)).not.toThrow()
  })
})
