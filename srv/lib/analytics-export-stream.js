// ESM. Pure helpers exported for unit tests; the streaming handler is wired
// to express in Task 14 and consumes these helpers + cds.db.

const NEEDS_QUOTE_RE = /[",\n\r]/

function csvCell(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v.toString('base64')
  if (typeof v === 'object') v = JSON.stringify(v)
  const s = String(v)
  if (NEEDS_QUOTE_RE.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function csvHeader(columns) {
  return columns.map(csvCell).join(',') + '\n'
}

export function csvRow(values) {
  return values.map(csvCell).join(',') + '\n'
}

export function formatTruncationComment({ cap, rowCount }) {
  if (cap === 'rowCount') return `\n# truncated: 100000 row cap (${rowCount} rows)\n`
  if (cap === 'wallClock') return `\n# truncated: 60s wall-clock cap (${rowCount} rows)\n`
  return ''
}

/**
 * streamCsv — drives the response stream. Caller provides the validated SQL
 * (already wrapped with LIMIT 100000 by the express bridge) and a writable
 * `res` (express response). Writes header + rows + optional truncation comment.
 *
 * Hard caps:
 *   - 100,000 rows (enforced by SQL wrapper, double-checked here)
 *   - 60 seconds wall-clock (checked between pages)
 *
 * Streams in pages of `pageSize` rows so memory stays bounded regardless of
 * result-set size, and the wall-clock guard can preempt mid-export. Mirrors
 * the established project pattern used by srv/exports/assemble-csv-zip.js +
 * srv/exports/*.js (paginated db.run with LIMIT/OFFSET in an async iterator).
 *
 * The caller's `sql` is wrapped as `SELECT * FROM (...) t` so we can apply
 * a stable LIMIT/OFFSET on top — that requires the inner SQL to be a single
 * SELECT, which is what analytics-sql-validator already enforces.
 */
const DEFAULT_PAGE_SIZE = 5000

export async function streamCsv({ db, sql, res, log, user, sqlLength, pageSize = DEFAULT_PAGE_SIZE }) {
  const startedAt = Date.now()
  let rowCount = 0
  let header = false
  let cap = null
  let offset = 0

  // Strip a trailing LIMIT N from the wrapper before paginating, then re-cap
  // total emitted rows at min(N, 100000). The express bridge already wraps
  // user SQL as "SELECT * FROM (validated) t LIMIT 100000", so the M we see
  // here is the export cap.
  const wrapMatch = /^\s*([\s\S]*?)\s+LIMIT\s+(\d+)\s*$/i.exec(sql)
  const baseQuery = wrapMatch ? wrapMatch[1] : sql
  const totalCap  = wrapMatch ? Math.min(Number(wrapMatch[2]) || 100000, 100000) : 100000

  outer: while (rowCount < totalCap) {
    const remaining = totalCap - rowCount
    const limit = Math.min(pageSize, remaining)
    const pageQuery = baseQuery + ' LIMIT ' + limit + ' OFFSET ' + offset

    const page = await db.run(pageQuery)
    if (!page.length) break

    for (const row of page) {
      if (!header) {
        res.write(csvHeader(Object.keys(row)))
        header = true
      }
      res.write(csvRow(Object.values(row)))
      rowCount++
      if (rowCount >= totalCap) { cap = 'rowCount'; break outer }
    }

    if (Date.now() - startedAt > 60000) { cap = 'wallClock'; break }
    if (page.length < limit) break // last page
    offset += limit
  }

  if (cap) res.write(formatTruncationComment({ cap, rowCount }))
  res.end()

  if (log) {
    log.info({
      user, action: 'exportSelectQuery',
      sqlLength, durationMs: Date.now() - startedAt,
      rowCount, capHit: cap,
    })
  }
}
