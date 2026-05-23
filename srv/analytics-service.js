import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { validateSelect } = require('./lib/analytics-sql-validator.cjs')

export default class AnalyticsService extends cds.ApplicationService {
  async init() {
    await super.init()

    const srv = this

    function getExposedEntries() {
      const out = []
      for (const def of Object.values(cds.model.definitions)) {
        if (def.kind !== 'entity') continue
        if (!def['@analytics.exposed']) continue
        const projectionName = def.name.split('.').pop()
        const projection = srv.entities[projectionName]
        if (!projection) continue
        out.push({ def, projection, projectionName })
      }
      return out
    }

    function getAllowedTableNames() {
      const set = new Set()
      for (const { def, projectionName } of getExposedEntries()) {
        set.add(projectionName)
        // HANA physical name: COM_SAP_DEVELOPERS_IMS_TUTORIALS
        const hanaName = def.name.replace(/\./g, '_').toUpperCase()
        set.add(hanaName)
        // SQLite physical name: com_sap_developers_ims_Tutorials (mixed case)
        const sqliteName = def.name.replace(/\./g, '_')
        set.add(sqliteName)
      }
      return set
    }

    function stringify(value) {
      if (value === null || value === undefined) return null
      if (value instanceof Date) return value.toISOString()
      if (Buffer.isBuffer(value)) return value.toString('base64')
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    }

    this.on('listExposedEntities', () => {
      const out = []
      for (const { def, projection, projectionName } of getExposedEntries()) {
        out.push({
          name: projectionName,
          label: def['@analytics.label'] || projectionName,
          description: def.doc || '',
          columns: Object.entries(projection.elements)
            .filter(([, c]) => !c.virtual && !c.target)
            .map(([n, c]) => ({
              name: n,
              type: c.type,
              nullable: c.notNull !== true,
              length: c.length || null,
            })),
        })
      }
      return out.sort((a, b) => a.label.localeCompare(b.label))
    })

    this.on('runSelectQuery', async (req) => {
      const { sql } = req.data || {}
      let validated
      try {
        validated = validateSelect(sql, getAllowedTableNames())
      } catch (err) {
        cds.log('analytics-sql').warn({
          user: req.user.id,
          sqlLength: typeof sql === 'string' ? sql.length : 0,
          reason: 'validator',
          error: err.message,
        })
        return req.reject(400, err.message)
      }
      const start = Date.now()
      const isHana = cds.db && cds.db.kind === 'hana'
      // HANA: runtime via WITH HINT clause (spec §Backend, security).
      // SQLite (unit tests): omit; the dialect doesn't support it.
      const wrapped = isHana
        ? `SELECT * FROM (${validated.sql}) t LIMIT 5001 WITH HINT (STATEMENT_TIMEOUT(30))`
        : `SELECT * FROM (${validated.sql}) t LIMIT 5001`
      let rows
      try {
        rows = await cds.run(wrapped)
      } catch (err) {
        cds.log('analytics-sql').warn({ user: req.user.id, error: err.message })
        return req.reject(400, `Query failed: ${err.message}`)
      }
      const durationMs = Date.now() - start
      const truncated = rows.length > 5000
      const data = truncated ? rows.slice(0, 5000) : rows
      const columns = data.length ? Object.keys(data[0]) : validated.selectedColumns
      cds.log('analytics-sql').info({
        user: req.user.id, sqlLength: sql.length, durationMs,
        rowCount: data.length, truncated,
      })
      return {
        columns,
        rows: data.map(r => columns.map(c => stringify(r[c]))),
        metadata: { rowCount: data.length, truncated, durationMs },
      }
    })

    // Startup warning: projection without annotation
    this.on('served', () => {
      const annotated = new Set(getExposedEntries().map(e => e.projectionName))
      for (const e of Object.values(srv.entities)) {
        if (e.kind === 'entity' && !annotated.has(e.name.split('.').pop())) {
          cds.log('analytics').warn(
            `Projection ${e.name} is in AnalyticsService but underlying entity lacks @analytics.exposed`)
        }
      }
    })
  }
}
