import { useAuth } from '../composables/useAuth'

export interface DimensionConfig { column: string; dataType: string }
export interface MeasureConfig { column: string; aggregation: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT'; alias: string }
export interface FilterConfig { column: string; operator: string; value: string | number }
export interface ChartConfigInput {
  entity: string
  dimensions: DimensionConfig[]
  measures: MeasureConfig[]
  filters: FilterConfig[]
  orderBy: { column: string; direction: 'asc' | 'desc' } | null
  topN: number | null
}

const AGG_TO_ODATA: Record<MeasureConfig['aggregation'], string> = {
  SUM: 'sum', AVG: 'average', MIN: 'min', MAX: 'max', COUNT: 'countdistinct',
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ALLOWED_OPERATORS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startswith', 'endswith'])

function assertIdent(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`invalid ${kind}: ${name}`)
}

function assertOperator(op: string): void {
  if (!ALLOWED_OPERATORS.has(op)) throw new Error(`invalid operator: ${op}`)
}

export function buildApplyUrl(cfg: ChartConfigInput): string {
  assertIdent(cfg.entity, 'entity')
  for (const d of cfg.dimensions) assertIdent(d.column, 'dimension column')
  for (const m of cfg.measures) {
    assertIdent(m.column, 'measure column')
    assertIdent(m.alias, 'measure alias')
  }
  for (const f of cfg.filters) {
    assertIdent(f.column, 'filter column')
    assertOperator(f.operator)
  }
  if (cfg.orderBy) assertIdent(cfg.orderBy.column, 'orderBy column')

  const parts: string[] = []
  if (cfg.filters.length) {
    const fs = cfg.filters.map(f => formatFilter(f)).join(' and ')
    parts.push(`filter(${fs})`)
  }
  if (cfg.dimensions.length || cfg.measures.length) {
    const dims = cfg.dimensions.map(d => d.column).join(',')
    const aggs = cfg.measures.map(m => `${m.column} with ${AGG_TO_ODATA[m.aggregation]} as ${m.alias}`).join(',')
    parts.push(`groupby((${dims})${aggs ? `,aggregate(${aggs})` : ''})`)
  }
  if (cfg.orderBy) {
    parts.push(`orderby(${cfg.orderBy.column} ${cfg.orderBy.direction})`)
  }
  if (cfg.topN) {
    // HANA has no TOPCOUNT function, so we can't use the OData topcount(N,col)
    // shortcut. Emit orderby(col desc)/top(N) instead — same effect, primitives
    // CAP can translate cleanly. If the caller already supplied an explicit
    // orderby we keep it and just append top(N).
    if (!cfg.orderBy) {
      const tcCol = cfg.measures[0]?.alias ?? cfg.dimensions[0]?.column
      if (!tcCol) throw new Error('topN requires orderBy, a measure, or a dimension')
      parts.push(`orderby(${tcCol} desc)`)
    }
    parts.push(`top(${cfg.topN})`)
  }
  const apply = parts.join('/')
  // Role-aware base path: admins hit /admin/analytics/<Entity>, authors hit
  // /author/<Entity>. The author surface exposes the same curated entities
  // with the same $apply semantics (groupby/aggregate/orderby/top).
  const { servicePath } = useAuth()
  return `${servicePath.value}${cfg.entity}?$apply=${encodeURIComponent(apply)}`
}

function formatFilter(f: FilterConfig): string {
  const v = typeof f.value === 'number' ? String(f.value) : `'${String(f.value).replace(/'/g, "''")}'`
  return `${f.column} ${f.operator} ${v}`
}
