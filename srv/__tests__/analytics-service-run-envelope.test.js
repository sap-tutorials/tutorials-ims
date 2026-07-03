import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.runSelectQuery — Phase 1 envelope', () => {
  const asAdmin = (srv, fn) =>
    srv.tx({ user: new cds.User.Privileged() }, fn)

  it('returns privacy: { mode: "raw" } and a historyId', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await asAdmin(srv, tx =>
      tx.send('runSelectQuery', {
        sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
        source: 'builder',
      }))
    expect(r.privacy).toEqual({ mode: 'raw', suppressedCells: 0 })
    expect(r.historyId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('writes a row to AnalyticsQueryHistory with the source parameter', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const db = await cds.connect.to('db')
    const r = await asAdmin(srv, tx =>
      tx.send('runSelectQuery', {
        sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
        source: 'editor',
      }))
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row).toBeTruthy()
    expect(row.source).toBe('editor')
    expect(row.privacyMode).toBe('raw')
  })

  it('normalizes unknown source values to "editor"', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const db = await cds.connect.to('db')
    const r = await asAdmin(srv, tx =>
      tx.send('runSelectQuery', {
        sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
        source: 'definitely-not-valid',
      }))
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row.source).toBe('editor')
  })

  it('does not break when source is missing (back-compat)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await asAdmin(srv, tx =>
      tx.send('runSelectQuery', {
        sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
      }))
    expect(r.privacy).toEqual({ mode: 'raw', suppressedCells: 0 })
    expect(r.historyId).toBeTruthy()
  })
})

describe('runSelectQuery — spec parameter (Phase 4)', () => {
  const asAdmin = (srv, fn) =>
    srv.tx({ user: new cds.User.Privileged() }, fn)

  it('writes spec verbatim to AnalyticsQueryHistory when provided', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const db = await cds.connect.to('db')
    const specJson = JSON.stringify({ version: 1, hint: 'phase4-test' })

    const r = await asAdmin(srv, tx => tx.send('runSelectQuery', {
      sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
      source: 'builder',
      spec: specJson,
    }))

    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row.spec).toBe(specJson)
  })

  it('writes spec=null when omitted (back-compat)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const db = await cds.connect.to('db')

    const r = await asAdmin(srv, tx => tx.send('runSelectQuery', {
      sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
      source: 'editor',
    }))

    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row.spec).toBe(null)
  })
})
