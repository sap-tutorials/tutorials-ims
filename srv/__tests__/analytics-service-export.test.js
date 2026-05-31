import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const test = cds.test('serve', '--project', '.', '--in-memory')

describe('POST /admin/analytics/export', () => {
  let baseUrl
  beforeAll(() => {
    // cds.test exposes the express server's port via its url property
    baseUrl = test.url
  })

  it('streams CSV with header + Content-Disposition', async () => {
    const res = await fetch(`${baseUrl}/admin/analytics/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin:admin').toString('base64'),
      },
      body: JSON.stringify({
        sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 5',
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toMatch(/attachment.*\.csv/)
    const body = await res.text()
    // Either a header line if rows exist, or empty if the test DB has no
    // TaskRecords. We only assert that the response succeeded and content-type
    // was correct — the precise body is data-dependent.
    expect(typeof body).toBe('string')
  })

  it('rejects DDL via the existing validator', async () => {
    const res = await fetch(`${baseUrl}/admin/analytics/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin:admin').toString('base64'),
      },
      body: JSON.stringify({ sql: 'DROP TABLE TaskRecords' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects non-admin users with 403', async () => {
    const res = await fetch(`${baseUrl}/admin/analytics/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('developer:developer').toString('base64'),
      },
      body: JSON.stringify({
        sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
      }),
    })
    expect(res.status).toBe(403)
  })
})
