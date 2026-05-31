// Express bridge for AnalyticsService.exportSelectQuery — streams CSV.
// Mounted at POST /admin/analytics/export. Same security model as
// runSelectQuery (Admin scope + analytics-sql-validator allowlist).

import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { streamCsv } from './analytics-export-stream.js'

const require = createRequire(import.meta.url)
const { validateSelect } = require('./analytics-sql-validator.cjs')

export async function exportSelectQueryHandler(req, res) {
  try {
    // CAP's contextMw populates cds.context.user; some adapters also mirror
    // it onto req.user. Read whichever is available.
    const user = req.user || cds.context?.user
    if (!user || user.id === 'anonymous') {
      return res.status(401).json({ error: 'Authentication required' })
    }
    if (typeof user.is === 'function' && !user.is('Admin')) {
      return res.status(403).json({ error: 'Admin scope required' })
    }
    const { sql } = req.body || {}
    if (typeof sql !== 'string' || !sql.trim()) {
      return res.status(400).json({ error: 'sql is required' })
    }

    const srv = await cds.connect.to('AnalyticsService')
    const allowed = srv._getAllowedTableNames?.()
    if (!allowed) {
      return res.status(500).json({ error: 'AnalyticsService not initialized' })
    }
    let validated
    try {
      validated = validateSelect(sql, allowed)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
    const wrapped = `SELECT * FROM (${validated.sql}) t LIMIT 100000`

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${Date.now()}.csv"`)
    res.setHeader('Cache-Control', 'no-store')

    await streamCsv({
      db: cds.db, sql: wrapped, res,
      log: cds.log('analytics-sql'),
      user: user.id, sqlLength: sql.length,
    })
  } catch (err) {
    cds.log('analytics-sql').error({
      user: (req.user || cds.context?.user)?.id, action: 'exportSelectQuery', error: err.message,
    })
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' })
  }
}
