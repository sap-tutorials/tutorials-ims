import type { ExposedEntity } from '../api/entities'

export interface RedactInput {
  entityName: string
  columns: string[]
  rows: any[][]
}

export interface RedactOutput {
  columns: string[]
  rows: any[][]
  redactedColumns: string[]
  truncated: boolean
}

const REDACTED = '[REDACTED]' as const
const MAX_ROWS = 50

export function redactPii(input: RedactInput, entities: ExposedEntity[]): RedactOutput {
  const entity = entities.find(e => e.name === input.entityName)
  const piiSet = new Set<string>()
  if (entity) {
    for (const col of entity.columns) {
      if (col.pii === true) piiSet.add(col.name)
    }
  }
  const redactIdx = input.columns
    .map((c, i) => piiSet.has(c) ? i : -1)
    .filter(i => i >= 0)

  const truncated = input.rows.length > MAX_ROWS
  const sourceRows = truncated ? input.rows.slice(0, MAX_ROWS) : input.rows
  const rows = redactIdx.length === 0
    ? sourceRows.map(r => r.slice())
    : sourceRows.map(r => r.map((v, i) => redactIdx.includes(i) ? REDACTED : v))

  return {
    columns: input.columns.slice(),
    rows,
    redactedColumns: input.columns.filter(c => piiSet.has(c)),
    truncated,
  }
}
