// Hybrid test: verify that a newly-inserted active redirect is picked up
// after a manual refresh() call (#639).
//
// Requires: cf login to DEV space + live srv at localhost:4004 (or SMOKE_SRV_URL).
// Run with: npm run test:hybrid
//
// DO NOT run in a plain `npm test` (unit) session — the guard will bail early.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { refresh, getIndex } from '../../approuter/lib/legacy-redirects-loader.js'
import { resolveRedirect } from '../../srv/lib/legacy-redirects-resolver.js'
import { isSafeForWrites } from './_guard.js'

describe('Legacy redirects hot-reload (hybrid)', () => {
  it('newly inserted active redirect is picked up after refresh()', async () => {
    if (!isSafeForWrites() || process.env.ALLOW_HYBRID_WRITES !== 'true') return

    const db = await cds.connect.to('db')
    const id = cds.utils.uuid()

    await db.run(INSERT.into('com.sap.developers.ims.LegacyRedirects').entries({
      ID: id,
      fromPath: '/__test_hot_reload__.html',
      toPath: '/',
      statusCode: 301,
      isPattern: false,
      isActive: true
    }))

    try {
      const srvUrl = process.env.SMOKE_SRV_URL || 'http://localhost:4004'
      await refresh(srvUrl)
      expect(resolveRedirect(getIndex(), '/__test_hot_reload__.html')).toEqual(
        expect.objectContaining({ toPath: '/' })
      )
    } finally {
      await db.run(DELETE.from('com.sap.developers.ims.LegacyRedirects').where({ ID: id }))
    }
  })
})
