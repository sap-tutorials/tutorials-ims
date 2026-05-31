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

  it('rejects SQL > 16384 chars', () => {
    // Limit bumped from 4096 to 16384 in Phase 1 to accommodate verbose
    // qualified SQL emitted by the chip builder.
    const big = 'SELECT * FROM TaskRecords WHERE 1=1 ' + 'AND id IS NOT NULL '.repeat(900)
    expect(big.length).toBeGreaterThan(16384)
    expect(() => validateSelect(big, ALLOWED)).toThrow(/16384|exceeds maximum|length/i)
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

describe('analytics-sql-validator — Phase 1 additions', () => {
  it('accepts SQL up to 16384 chars', () => {
    const filler = Array.from({ length: 800 }, (_, i) => `id = '${i}'`).join(' OR ')
    const longSql = `SELECT id FROM TaskRecords WHERE ${filler}`
    expect(longSql.length).toBeGreaterThan(4096)
    expect(longSql.length).toBeLessThan(16384)
    const r = validateSelect(longSql, ALLOWED)
    expect(r.sql).toMatch(/SELECT/i)
  })

  it('rejects SQL above 16384 chars', () => {
    const filler = Array.from({ length: 1500 }, (_, i) => `id = '${i.toString().padStart(8,'0')}'`).join(' OR ')
    const tooLong = `SELECT id FROM TaskRecords WHERE ${filler}`
    expect(tooLong.length).toBeGreaterThan(16384)
    expect(() => validateSelect(tooLong, ALLOWED)).toThrow(/exceeds maximum/)
  })

  it('accepts whitelisted scalar functions YEAR/MONTH', () => {
    const r = validateSelect(
      'SELECT YEAR(createdAt) AS y, MONTH(createdAt) AS m FROM TaskRecords', ALLOWED)
    expect(r.sql.toUpperCase()).toContain('YEAR')
  })

  it('rejects suspicious functions (os_command)', () => {
    expect(() =>
      validateSelect("SELECT os_command('ls') FROM TaskRecords", ALLOWED)
    ).toThrow(/function|allowlist|not allowed/i)
  })
})
