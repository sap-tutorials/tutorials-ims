import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { specToSql } from '../spec-to-sql.mjs'

// Tests use TaskRecords (which carries user_ID, event_ID, status COMPLETED/IN_PROGRESS,
// completionDate). Tasks is a UNION view with no FK columns and a different status enum;
// see srv/lib/__tests__/query-spec-validator.test.js for the schema rationale.
//
// Most tests use HANA-style SQL_NAMES (all-uppercase table names). The
// dialect detector reads the table-name casing — uppercase => HANA — and
// folds CDS column names to upper case to match HANA's physical storage
// (e.g. legacyId -> LEGACYID). A SQLite-dialect block at the bottom pins
// the inverse case for the test path.
const SQL_NAMES = { TaskRecords: 'TASKRECORDS', Users: 'USERS' }
const SQL_NAMES_SQLITE = { TaskRecords: 'com_sap_developers_ims_TaskRecords', Users: 'com_sap_developers_ims_Users' }

describe('spec-to-sql', () => {
  it('emits a minimal single-table SELECT', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [], filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/^SELECT\s+tr\.ID\s+FROM\s+TASKRECORDS\s+tr\s*$/)
  })

  it('quotes string literals in eq filters and uses parens around tree', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: 'COMPLETED' } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("WHERE (tr.STATUS = 'COMPLETED')")
  })

  it('escapes single quotes in string literals', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: "O'Brien" } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("'O''Brien'")
  })

  it('rejects raw single-quote injection attempts via list values', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'in',
          value: { kind: 'list', value: ["x'; DROP TABLE TaskRecords; --"] } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    // Escaped: doubled single quote inside the literal — SQL sees it as a
    // single string ending in --, never breaks out of the quoted context.
    expect(sql).toContain("'x''; DROP TABLE TaskRecords; --'")
    // The injection attempt would have produced an UN-escaped break-out
    // pattern: "x'; DROP TABLE TaskRecords; --". The escaped output must not
    // contain that exact substring (without the doubled quote).
    expect(sql).not.toMatch(/[^']'; DROP TABLE TaskRecords/)
  })

  it('emits OR group with proper parens and AND default at top', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: 'COMPLETED' } },
        { id: 'fg2', kind: 'group', conjunction: 'or', children: [
          { id: 'f2', ref: { alias: 'tr', column: 'taskType' }, op: 'eq',
            value: { kind: 'literal', value: 'TUTORIAL' } },
          { id: 'f3', ref: { alias: 'tr', column: 'taskType' }, op: 'eq',
            value: { kind: 'literal', value: 'MISSION' } },
        ] }
      ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/WHERE \(tr\.STATUS = 'COMPLETED' AND \(tr\.TASKTYPE = 'TUTORIAL' OR tr\.TASKTYPE = 'MISSION'\)\)/)
  })

  it('emits INNER JOIN with ON', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [{ id: 'j1', kind: 'inner', target: { entity: 'Users', alias: 'u' },
        on: { leftRef: {alias:'tr',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }],
      filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain('INNER JOIN USERS u ON tr.USER_ID = u.ID')
  })

  it('auto-derives GROUP BY from non-aggregation SELECT chips when an aggregation is present', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 'tr', column: 'status' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
      ],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain('GROUP BY tr.STATUS')
    expect(sql).toMatch(/SELECT tr\.STATUS, COUNT\(\*\) AS cnt/)
  })

  it('does not emit GROUP BY when no aggregation present', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column', id: 's1', ref: { alias: 'tr', column: 'status' } },
        { kind: 'column', id: 's2', ref: { alias: 'tr', column: 'ID' } },
      ],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).not.toContain('GROUP BY')
  })

  it('orders by selectId alias and supports asc/desc', () => {
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 'tr', column: 'status' } },
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
      from: { entity: 'TaskRecords', alias: 'tr' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 'tr', column: 'createdAt' }, op: 'sinceDays',
          value: { kind: 'relative', value: 30 } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/tr\.CREATEDAT >= ADD_DAYS\(CURRENT_DATE,\s*-30\)/)
  })

  it('produces SQL that passes analytics-sql-validator', () => {
    const { validateSelect } = require('../analytics-sql-validator.cjs')
    const ALLOWED = new Set(['TASKRECORDS', 'USERS', 'TaskRecords', 'Users'])
    const spec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [{ id: 'j1', kind: 'inner', target: { entity: 'Users', alias: 'u' },
        on: { leftRef: {alias:'tr',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 'tr', column: 'status' }, op: 'in',
          value: { kind: 'list', value: ['COMPLETED', 'IN_PROGRESS'] } } ] },
      groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 'tr', column: 'event_ID' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'record_count' },
      ],
      orderBy: [{ id:'o1', by: { kind: 'selectId', id: 's2' }, direction: 'desc' }],
      limit: 10,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(() => validateSelect(sql, ALLOWED)).not.toThrow()
  })

  describe('SQLite dialect', () => {
    it('preserves CDS-form column names when sqlNames are mixed-case (sqlite)', () => {
      const spec = {
        version: 1,
        from: { entity: 'TaskRecords', alias: 'tr' }, joins: [], filterTree: null, groupBy: [],
        select: [
          { kind: 'column', id: 's1', ref: { alias: 'tr', column: 'createdAt' } },
          { kind: 'column', id: 's2', ref: { alias: 'tr', column: 'legacyId' } },
        ],
        orderBy: [], limit: null,
      }
      const sql = specToSql(spec, SQL_NAMES_SQLITE)
      expect(sql).toContain('tr.createdAt')
      expect(sql).toContain('tr.legacyId')
      expect(sql).toContain('FROM com_sap_developers_ims_TaskRecords tr')
    })

    it('honors explicit dialect override even when sqlNames look HANA-like', () => {
      const spec = {
        version: 1,
        from: { entity: 'TaskRecords', alias: 'tr' }, joins: [], filterTree: null, groupBy: [],
        select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'createdAt' } }],
        orderBy: [], limit: null,
      }
      const sql = specToSql(spec, SQL_NAMES, { dialect: 'sqlite' })
      expect(sql).toContain('tr.createdAt')
      expect(sql).not.toContain('tr.CREATEDAT')
    })
  })
})
