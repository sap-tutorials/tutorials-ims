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
 *   - 60 seconds wall-clock (checked every 1000 rows)
 *
 * Phase 1 uses db.run() which materializes the result. For very large exports
 * a Phase 1.1 follow-up would switch to a HANA cursor-based stream.
 */
export async function streamCsv({ db, sql, res, log, user, sqlLength }) {
  const startedAt = Date.now()
  let rowCount = 0
  let header = false
  let cap = null

  const rows = await db.run(sql)
  for (const row of rows) {
    if (!header) {
      res.write(csvHeader(Object.keys(row)))
      header = true
    }
    res.write(csvRow(Object.values(row)))
    rowCount++
    if (rowCount >= 100000) { cap = 'rowCount'; break }
    if (rowCount % 1000 === 0 && Date.now() - startedAt > 60000) { cap = 'wallClock'; break }
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
