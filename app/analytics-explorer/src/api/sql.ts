export interface SqlResult {
  columns: string[]
  rows: Array<Array<string | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells: number }
  historyId?: string
}

export async function runSelectQuery(
  sql: string,
  source: 'builder' | 'editor' | 'joule' | 'replay' = 'editor',
  spec?: string,  // optional JSON-stringified QuerySpec
): Promise<SqlResult> {
  const r = await fetch('/admin/analytics/runSelectQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sql, source, ...(spec ? { spec } : {}) }),
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`runSelectQuery ${r.status}: ${text}`)
  }
  const result = await r.json()
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
    throw new Error('runSelectQuery: malformed response')
  }
  return result as SqlResult
}
