export interface SqlResult {
  columns: string[]
  rows: Array<Array<string | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
}

export async function runSelectQuery(sql: string): Promise<SqlResult> {
  const r = await fetch('/admin/analytics/runSelectQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sql }),
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`runSelectQuery ${r.status}: ${text}`)
  }
  const json = await r.json()
  return (json.value || json) as SqlResult
}
