import { describe, it, expect } from 'vitest'
import { validateSelect } from '../analytics-sql-validator.cjs'

const ALLOWED = new Set(['TaskRecords', 'Users', 'Missions',
  'SAP_TUTORIALS_IMS_TASKRECORDS', 'SAP_TUTORIALS_IMS_USERS', 'SAP_TUTORIALS_IMS_MISSIONS'])

describe('analytics-sql-validator', () => {
  it('accepts a simple SELECT against an allowed table', () => {
    const r = validateSelect('SELECT id, status FROM TaskRecords', ALLOWED)
    expect(r.sql.toUpperCase()).toContain('SELECT')
  })

  it('accepts JOIN across two allowed tables', () => {
    const r = validateSelect(
      'SELECT t.id, u.email FROM TaskRecords t JOIN Users u ON t.user_id = u.id', ALLOWED)
    expect(r.sql.toUpperCase()).toContain('JOIN')
  })

  it('rejects DDL', () => {
    expect(() => validateSelect('DROP TABLE TaskRecords', ALLOWED)).toThrow(/select/i)
  })

  it('rejects DML', () => {
    expect(() => validateSelect("UPDATE TaskRecords SET status='X'", ALLOWED)).toThrow(/select/i)
    expect(() => validateSelect('DELETE FROM TaskRecords', ALLOWED)).toThrow(/select/i)
    expect(() => validateSelect("INSERT INTO TaskRecords (id) VALUES ('x')", ALLOWED)).toThrow(/select/i)
  })

  it('rejects multiple statements', () => {
    expect(() => validateSelect('SELECT 1 FROM TaskRecords; SELECT 1 FROM Users', ALLOWED))
      .toThrow(/single statement|one statement/i)
  })

  it('rejects access to a non-allowlisted table', () => {
    expect(() => validateSelect('SELECT * FROM SecretTable', ALLOWED))
      .toThrow(/not.*allow/i)
  })

  it('rejects subquery against a non-allowlisted table', () => {
    expect(() => validateSelect(
      'SELECT * FROM TaskRecords WHERE id IN (SELECT id FROM SecretTable)', ALLOWED))
      .toThrow(/not.*allow/i)
  })

  it('rejects SQL > 4096 chars', () => {
    const big = 'SELECT * FROM TaskRecords WHERE 1=1 ' + 'AND id IS NOT NULL '.repeat(500)
    expect(() => validateSelect(big, ALLOWED)).toThrow(/4096|length/i)
  })

  it('rejects line-comment markers', () => {
    expect(() => validateSelect('SELECT 1 FROM TaskRecords -- hi', ALLOWED))
      .toThrow(/comment/i)
  })

  it('rejects block-comment markers', () => {
    expect(() => validateSelect('SELECT 1 FROM TaskRecords /* hi */', ALLOWED))
      .toThrow(/comment/i)
  })

  it('rejects empty / whitespace-only input', () => {
    expect(() => validateSelect('', ALLOWED)).toThrow(/empty|missing/i)
    expect(() => validateSelect('   \n\t  ', ALLOWED)).toThrow(/empty|missing/i)
  })

  it('returns selectedColumns from explicit SELECT list', () => {
    const r = validateSelect('SELECT id, status FROM TaskRecords', ALLOWED)
    expect(r.selectedColumns).toEqual(['id', 'status'])
  })

  it('returns empty selectedColumns for SELECT *', () => {
    const r = validateSelect('SELECT * FROM TaskRecords', ALLOWED)
    expect(r.selectedColumns).toEqual([])
  })

  it('rejects scalar subquery in SELECT against a non-allowlisted table', () => {
    expect(() => validateSelect(
      'SELECT (SELECT id FROM SecretTable) AS x FROM TaskRecords', ALLOWED))
      .toThrow(/not.*allow/i)
  })

  it('rejects subquery in HAVING against a non-allowlisted table', () => {
    expect(() => validateSelect(
      'SELECT user_id, count(*) c FROM TaskRecords GROUP BY user_id HAVING c > (SELECT count(*) FROM SecretTable)',
      ALLOWED)).toThrow(/not.*allow/i)
  })
})
