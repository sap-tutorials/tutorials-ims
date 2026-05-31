// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { redactPii } from '../redactPii'
import type { ExposedEntity } from '../../api/entities'

const entities: ExposedEntity[] = [
  {
    name: 'Users',
    sqlName: 'COM_SAP_DEVELOPERS_IMS_USERS',
    label: 'Users',
    description: '',
    columns: [
      { name: 'ID', type: 'cds.UUID', nullable: false, length: null, pii: false },
      { name: 'email', type: 'cds.String', nullable: true, length: 255, pii: true },
      { name: 'firstName', type: 'cds.String', nullable: true, length: 50, pii: true },
      { name: 'createdAt', type: 'cds.Timestamp', nullable: true, length: null, pii: false },
    ],
  },
]

describe('redactPii', () => {
  it('replaces PII column values with [REDACTED]', () => {
    const out = redactPii({
      entityName: 'Users',
      columns: ['ID', 'email', 'firstName', 'createdAt'],
      rows: [['u1', 'a@b.com', 'Alice', '2026-01-01']],
    }, entities)
    expect(out.rows[0]).toEqual(['u1', '[REDACTED]', '[REDACTED]', '2026-01-01'])
    expect(out.redactedColumns).toEqual(['email', 'firstName'])
  })

  it('passes through non-PII columns unchanged', () => {
    const out = redactPii({
      entityName: 'Users',
      columns: ['ID', 'createdAt'],
      rows: [['u1', '2026-01-01']],
    }, entities)
    expect(out.rows[0]).toEqual(['u1', '2026-01-01'])
    expect(out.redactedColumns).toEqual([])
  })

  it('returns input unchanged when entity is unknown', () => {
    const out = redactPii({
      entityName: 'Unknown',
      columns: ['x'],
      rows: [['y']],
    }, entities)
    expect(out.rows[0]).toEqual(['y'])
  })

  it('caps rows at 50 by default', () => {
    const big = Array.from({ length: 200 }, (_, i) => ['u' + i, `email${i}`, 'Alice', '2026'])
    const out = redactPii({
      entityName: 'Users',
      columns: ['ID', 'email', 'firstName', 'createdAt'],
      rows: big,
    }, entities)
    expect(out.rows).toHaveLength(50)
    expect(out.truncated).toBe(true)
  })
})
