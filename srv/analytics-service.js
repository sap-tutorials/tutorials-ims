import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  validateSampleDistinctRequest,
  buildSampleDistinctSql,
  runSampleDistinct,
} from './lib/analytics-distinct-sample.js'
import { writeHistoryRow } from './lib/analytics-history-writer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { validateSelect } = require('./lib/analytics-sql-validator.cjs')
const { cdsTypeToHana } = require('./lib/cds-type-to-hana.cjs')

export default class AnalyticsService extends cds.ApplicationService {
  async init() {
    await super.init()

    const srv = this

    function getExposedEntries() {
      // CAP propagates @analytics.exposed from the base ims.X entity to every
      // projection across all services. Iterating cds.model.definitions and
      // matching by short name picks up the same projection multiple times
      // (one per service that exposes it). Restrict to the base ims.* namespace
      // so each entity surfaces exactly once.
      const out = []
      const seen = new Set()
      for (const def of Object.values(cds.model.definitions)) {
        if (def.kind !== 'entity') continue
        if (!def['@analytics.exposed']) continue
        if (!def.name.startsWith('com.sap.developers.ims.')) continue
        // Phase 1: defensively exclude admin-only history/saved tables — they
        // share the namespace but should never surface in the user-facing
        // builder. They don't carry @analytics.exposed today, but this guard
        // prevents future drift if someone copies the annotation pattern.
        if (/^com\.sap\.developers\.ims\.Analytics(QueryHistory|SavedQuery)$/.test(def.name)) continue
        const projectionName = def.name.split('.').pop()
        if (seen.has(projectionName)) continue
        const projection = srv.entities[projectionName]
        if (!projection) continue
        seen.add(projectionName)
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

    // Expose for the express bridge (analytics-export-handler.js).
    // Single-underscore prefix is the project's "internal but reachable" convention.
    this._getAllowedTableNames = getAllowedTableNames

    this.on('listExposedEntities', () => {
      // The SQL tab needs the name that actually executes at runtime. On HANA
      // the HDI container exposes the upper-case physical name (e.g.
      // COM_SAP_DEVELOPERS_IMS_TASKRECORDS); the short projection name fails
      // resolution. SQLite (unit tests) uses the mixed-case physical name.
      const isHana = cds.db && cds.db.kind === 'hana'
      const out = []
      for (const { def, projection, projectionName } of getExposedEntries()) {
        const hanaName = def.name.replace(/\./g, '_').toUpperCase()
        const sqliteName = def.name.replace(/\./g, '_')
        out.push({
          name: projectionName,
          sqlName: isHana ? hanaName : sqliteName,
          label: def['@analytics.label'] || projectionName,
          description: def.doc || '',
          columns: Object.entries(projection.elements)
            .filter(([, c]) => !c.virtual && !c.target)
            .map(([n, c]) => ({
              name: n,
              type: c.type,
              hanaType: cdsTypeToHana(c.type, c.length, c.precision, c.scale),
              nullable: c.notNull !== true,
              length: c.length || null,
              filterMode: c['@analytics.filter.mode'] || 'free',
              filterSample: !!c['@analytics.filter.sample'],
              pii: !!c['@analytics.pii'],
            })),
          associations: Object.entries(projection.elements)
            .filter(([, c]) => c.target)
            .map(([n, c]) => {
              const targetDef = cds.model.definitions[c.target]
              if (!targetDef || !targetDef['@analytics.exposed']) return null
              const targetShortName = c.target.split('.').pop()
              const onLocal  = (c.keys || []).map(k => k.$generatedFieldName || k.ref?.[0]).filter(Boolean)
              const onTarget = (c.keys || []).map(k => k.ref?.[0] || 'ID').filter(Boolean)
              const cardinality = (c.cardinality?.max === '*' || c.cardinality === '*') ? 'to-many' : 'to-one'
              return { name: n, targetEntity: targetShortName, cardinality, onLocal, onTarget }
            })
            .filter(Boolean),
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
      const wrapped = `SELECT * FROM (${validated.sql}) t LIMIT 5001`
      // 30s soft timeout via Promise.race. HANA's WITH HINT clause does not
      // support a STATEMENT_TIMEOUT hint, and the session-level
      // SET 'STATEMENT_TIMEOUT' would leak across the pooled connection.
      let rows
      try {
        rows = await Promise.race([
          cds.run(wrapped),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Query exceeded 30s timeout')), 30000)
          ),
        ])
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
      const historyId = await writeHistoryRow({
        user: req.user.id,
        sql,
        rowCount: data.length,
        durationMs,
        truncated,
        source: req.data.source,
      })
      return {
        columns,
        rows: data.map(r => columns.map(c => stringify(r[c]))),
        metadata: { rowCount: data.length, truncated, durationMs },
        privacy: { mode: 'raw', suppressedCells: 0 },
        historyId,
      }
    })

    this.on('sampleDistinct', async (req) => {
      const { table, column, limit } = req.data || {}

      // Look up column annotation by walking the exposed entries.
      // Also resolve the user-supplied table to the runtime-physical name.
      let columnAnnotation = null
      let physicalTable = null
      const isHana = cds.db && cds.db.kind === 'hana'
      for (const { def, projection, projectionName } of getExposedEntries()) {
        const hanaName = def.name.replace(/\./g, '_').toUpperCase()
        const sqliteName = def.name.replace(/\./g, '_')
        if ([projectionName, hanaName, sqliteName].includes(table)) {
          physicalTable = isHana ? hanaName : sqliteName
          const elem = projection.elements[column]
          if (elem) {
            columnAnnotation = {
              filterMode: elem['@analytics.filter.mode'] || 'free',
              filterSample: !!elem['@analytics.filter.sample'],
            }
          }
          break
        }
      }

      try {
        validateSampleDistinctRequest({
          table, column,
          allowedTables: getAllowedTableNames(),
          columnAnnotation,
        })
      } catch (err) {
        return req.reject(err.status || 400, err.message)
      }

      const sql = buildSampleDistinctSql({ table: physicalTable, column, cap: limit })
      try {
        return await runSampleDistinct({ db: cds.db, sql, cap: limit })
      } catch (err) {
        cds.log('analytics-sql').warn({
          user: req.user.id, action: 'sampleDistinct', error: err.message,
        })
        return req.reject(400, `sampleDistinct failed: ${err.message}`)
      }
    })

    // Startup warning: projection without annotation
    // ─── SavedQueries actions (Phase 1) ───────────────────────────────────
    this.on('rename', 'SavedQueries', async (req) => {
      const ID = req.params[0]?.ID
      const { name, description } = req.data
      if (typeof name !== 'string' || !name.trim()) return req.reject(400, 'name is required')
      await UPDATE(srv.entities.SavedQueries).set({ name, description }).where({ ID })
      return SELECT.one.from(srv.entities.SavedQueries).where({ ID })
    })

    this.on('setVisibility', 'SavedQueries', async (req) => {
      const ID = req.params[0]?.ID
      const { visibility } = req.data
      if (!['private', 'shared-admins'].includes(visibility)) {
        return req.reject(400, `visibility must be 'private' or 'shared-admins'`)
      }
      await UPDATE(srv.entities.SavedQueries).set({ visibility }).where({ ID })
      return SELECT.one.from(srv.entities.SavedQueries).where({ ID })
    })

    this.on('duplicate', 'SavedQueries', async (req) => {
      const ID = req.params[0]?.ID
      const original = await SELECT.one.from(srv.entities.SavedQueries).where({ ID })
      if (!original) return req.reject(404, 'saved query not found')
      const newID = cds.utils.uuid()
      await INSERT.into(srv.entities.SavedQueries).entries({
        ID: newID,
        name: `${original.name} (copy)`,
        description: original.description,
        sql: original.sql,
        spec: original.spec,
        rowCount: original.rowCount,
        durationMs: original.durationMs,
        truncated: original.truncated,
        privacyMode: original.privacyMode,
        visibility: 'private', // copies start private
      })
      return SELECT.one.from(srv.entities.SavedQueries).where({ ID: newID })
    })

    this.on('recordRun', 'SavedQueries', async (req) => {
      const ID = req.params[0]?.ID
      const { rowCount, durationMs } = req.data
      await UPDATE(srv.entities.SavedQueries).set({
        rowCount: Number(rowCount) || 0,
        durationMs: Number(durationMs) || 0,
        lastRunAt: new Date().toISOString(),
      }).where({ ID })
      return SELECT.one.from(srv.entities.SavedQueries).where({ ID })
    })

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
