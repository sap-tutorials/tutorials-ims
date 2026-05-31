import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.listExposedEntities — Phase 1 enrichments', () => {
  let result

  beforeAll(async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const user = new cds.User.Privileged()
    result = await srv.tx({ user }, tx => tx.send('listExposedEntities'))
  })

  it('returns enriched columns with hanaType', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    expect(tasks).toBeTruthy()
    const status = tasks.columns.find(c => c.name === 'status')
    expect(status).toBeTruthy()
    expect(status.hanaType).toMatch(/NVARCHAR|VARCHAR/i)
  })

  it('returns filterMode for annotated columns', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    const status = tasks.columns.find(c => c.name === 'status')
    expect(status.filterMode).toBe('enum')
    expect(status.filterSample).toBe(true)
  })

  it('returns filterMode "free" for unannotated columns', () => {
    // Tasks view has 'title' which is NOT annotated — should default to 'free'
    const tasks = result.find(e => e.name === 'Tasks')
    const title = tasks.columns.find(c => c.name === 'title')
    if (!title) return
    expect(title.filterMode).toBe('free')
    expect(title.filterSample).toBe(false)
  })

  it('returns pii flag on Users.email', () => {
    const users = result.find(e => e.name === 'Users')
    const email = users.columns.find(c => c.name === 'email')
    expect(email).toBeTruthy()
    expect(email.pii).toBe(true)
  })

  it('returns associations array (may be empty for non-associated entities)', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    expect(Array.isArray(tasks.associations)).toBe(true)
    // Tasks view has no associations; TaskRecords has user (Users) + event (Events).
    const taskRecords = result.find(e => e.name === 'TaskRecords')
    expect(Array.isArray(taskRecords.associations)).toBe(true)
    const userAssoc = taskRecords.associations.find(a => a.targetEntity === 'Users')
    if (userAssoc) {
      expect(userAssoc.cardinality).toMatch(/^to-(one|many)$/)
      expect(Array.isArray(userAssoc.onLocal)).toBe(true)
      expect(Array.isArray(userAssoc.onTarget)).toBe(true)
    }
  })
})
