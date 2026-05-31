// ESM module. Pure helpers exported separately for unit-test ergonomics;
// the handler glue function is wired into AnalyticsService in Task 11.

const COLUMN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateSampleDistinctRequest({ table, column, allowedTables, columnAnnotation }) {
  if (!table ||
      (!allowedTables.has(table) &&
       !allowedTables.has(String(table).toLowerCase()) &&
       !allowedTables.has(String(table).toUpperCase()))) {
    throw Object.assign(new Error(`Table '${table}' is not exposed`), { status: 403 })
  }
  if (!columnAnnotation || columnAnnotation.filterMode !== 'enum' || !columnAnnotation.filterSample) {
    throw Object.assign(new Error(`Column '${column}' is not eligible for distinct sampling`), { status: 403 })
  }
  if (!COLUMN_NAME_RE.test(column)) {
    throw Object.assign(new Error(`Bad column name: '${column}'`), { status: 400 })
  }
}

export function buildSampleDistinctSql({ table, column, cap }) {
  // Use Number(cap) directly so cap===0 clamps to 1 (the floor), not 100.
  const n = Number(cap)
  const safeCap = Math.min(Math.max(Number.isFinite(n) ? n : 100, 1), 200)
  // Both table and column have already been validated by validateSampleDistinctRequest.
  // We still wrap column in double-quotes (HANA identifier delimiter) defensively.
  return `SELECT DISTINCT "${column}" AS V FROM ${table} ORDER BY 1 LIMIT ${safeCap + 1}`
}

export async function runSampleDistinct({ db, sql, cap, timeoutMs = 30000 }) {
  const n = Number(cap)
  const safeCap = Math.min(Math.max(Number.isFinite(n) ? n : 100, 1), 200)
  const rows = await Promise.race([
    db.run(sql),
    new Promise((_, rej) => setTimeout(() => rej(new Error('sampleDistinct exceeded timeout')), timeoutMs)),
  ])
  const truncated = rows.length > safeCap
  return {
    values: rows.slice(0, safeCap).map(r => r.V === null || r.V === undefined ? '' : String(r.V)),
    truncated,
  }
}
