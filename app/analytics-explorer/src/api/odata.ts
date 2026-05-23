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

export function buildApplyUrl(cfg: ChartConfigInput): string {
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
    const tcCol = cfg.orderBy?.column ?? cfg.measures[0]?.alias ?? cfg.dimensions[0]?.column ?? ''
    parts.push(`topcount(${cfg.topN},${tcCol})`)
  }
  const apply = parts.join('/')
  return `/admin/analytics/${cfg.entity}?$apply=${encodeURIComponent(apply)}`
}

function formatFilter(f: FilterConfig): string {
  const v = typeof f.value === 'number' ? String(f.value) : `'${String(f.value).replace(/'/g, "''")}'`
  return `${f.column} ${f.operator} ${v}`
}
