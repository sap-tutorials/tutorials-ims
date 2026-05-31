import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.SavedQueries — Phase 1 CRUD + actions', () => {
  const asAdmin = (srv, fn) => srv.tx({ user: new cds.User.Privileged() }, fn)

  it('creates a saved query and reads it back', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await asAdmin(srv, tx =>
      tx.run(INSERT.into(srv.entities.SavedQueries).entries({
        name: '__TEST__ Phase1 saved',
        description: 'desc',
        sql: 'SELECT id FROM Tasks LIMIT 1',
        spec: '{}',
        visibility: 'private',
      })))
    expect(created).toBeTruthy()
  })

  it('rename action updates name and description', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const id = cds.utils.uuid()
    await asAdmin(srv, tx => tx.run(INSERT.into(srv.entities.SavedQueries).entries({
      ID: id, name: '__TEST__ to-rename', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })))
    const r = await asAdmin(srv, tx => tx.send({
      event: 'rename', entity: 'SavedQueries',
      params: [{ ID: id }],
      data: { name: '__TEST__ renamed', description: 'after' },
    }))
    expect(r.name).toBe('__TEST__ renamed')
    expect(r.description).toBe('after')
  })

  it('setVisibility flips private/shared-admins', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const id = cds.utils.uuid()
    await asAdmin(srv, tx => tx.run(INSERT.into(srv.entities.SavedQueries).entries({
      ID: id, name: '__TEST__ vis', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })))
    const r = await asAdmin(srv, tx => tx.send({
      event: 'setVisibility', entity: 'SavedQueries',
      params: [{ ID: id }],
      data: { visibility: 'shared-admins' },
    }))
    expect(r.visibility).toBe('shared-admins')
  })

  it('rejects setVisibility with an invalid value', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const id = cds.utils.uuid()
    await asAdmin(srv, tx => tx.run(INSERT.into(srv.entities.SavedQueries).entries({
      ID: id, name: '__TEST__ vis-bad', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })))
    await expect(asAdmin(srv, tx => tx.send({
      event: 'setVisibility', entity: 'SavedQueries',
      params: [{ ID: id }],
      data: { visibility: 'public-internet' },
    }))).rejects.toThrow(/visibility/)
  })

  it('duplicate creates a new row with " (copy)" suffix', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const id = cds.utils.uuid()
    await asAdmin(srv, tx => tx.run(INSERT.into(srv.entities.SavedQueries).entries({
      ID: id, name: '__TEST__ original', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })))
    const dup = await asAdmin(srv, tx => tx.send({
      event: 'duplicate', entity: 'SavedQueries',
      params: [{ ID: id }],
    }))
    expect(dup.name).toMatch(/__TEST__ original.*copy/i)
    expect(dup.ID).not.toBe(id)
  })

  it('recordRun updates lastRunAt + counters', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const id = cds.utils.uuid()
    await asAdmin(srv, tx => tx.run(INSERT.into(srv.entities.SavedQueries).entries({
      ID: id, name: '__TEST__ run', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })))
    const r = await asAdmin(srv, tx => tx.send({
      event: 'recordRun', entity: 'SavedQueries',
      params: [{ ID: id }],
      data: { rowCount: 42, durationMs: 100 },
    }))
    expect(r.rowCount).toBe(42)
    expect(r.durationMs).toBe(100)
    expect(r.lastRunAt).toBeTruthy()
  })
})
