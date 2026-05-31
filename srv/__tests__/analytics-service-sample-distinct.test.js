import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.sampleDistinct (integration)', () => {
  const asAdmin = (srv, fn) => srv.tx({ user: new cds.User.Privileged() }, fn)

  it('returns distinct values for Tasks.status (enum-annotated)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await asAdmin(srv, tx =>
      tx.send('sampleDistinct', { table: 'Tasks', column: 'status', limit: 50 }))
    expect(Array.isArray(r.values)).toBe(true)
    expect(typeof r.truncated).toBe('boolean')
  })

  it('rejects Users.email (not enum-annotated)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    await expect(
      asAdmin(srv, tx => tx.send('sampleDistinct', { table: 'Users', column: 'email', limit: 50 }))
    ).rejects.toThrow(/not eligible|403/i)
  })

  it('rejects an unknown table', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    await expect(
      asAdmin(srv, tx => tx.send('sampleDistinct', { table: 'Nope', column: 'status', limit: 50 }))
    ).rejects.toThrow(/not exposed|403/i)
  })
})
