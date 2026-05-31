import type { QuerySpec, FilterGroup, Filter, ColumnRef } from '../types/query-spec'

/**
 * Returns true if the given spec + clicked row support a drilldown.
 * Disabled cases (matches the spec):
 *   - No aggregation chips in the current spec (already showing raw rows)
 *   - Spec uses an expression-kind SELECT chip (can't reverse YEAR() etc.)
 *   - Clicked row has any NULL value in a non-aggregation column
 */
export function canDrillDown(spec: QuerySpec | null, row: Record<string, unknown>): boolean {
  if (!spec) return false
  const hasAgg = spec.select.some(s => s.kind === 'aggregation')
  if (!hasAgg) return false
  if (spec.select.some(s => s.kind === 'expression')) return false
  for (const s of spec.select) {
    if (s.kind !== 'column') continue
    const key = s.alias || s.ref.column
    if (row[key] === null || row[key] === undefined) return false
  }
  return true
}

/**
 * Build the drilldown QuerySpec:
 *   - Strip aggregation chips from select
 *   - Add equality filters for every non-aggregation column projection
 *   - Clear explicit groupBy (auto-derive doesn't apply with no aggregations)
 *   - Set LIMIT 200 (drill is for inspection, not export)
 *   - Preserve from/joins/orderBy verbatim
 */
export function deriveDrilldownSpec(
  spec: QuerySpec | null,
  row: Record<string, unknown>,
): QuerySpec | null {
  if (!canDrillDown(spec, row)) return null
  const s = spec!

  const projectedColumns = s.select.filter(item => item.kind === 'column') as Array<{
    kind: 'column'; id: string; ref: ColumnRef; alias?: string
  }>

  // Build a fresh filter group with one equality leaf per projected column.
  const stamp = Date.now()
  const drillChildren: Filter[] = projectedColumns.map((p, i) => {
    const key = p.alias || p.ref.column
    const v = row[key]
    return {
      id: `drill-f${i}-${stamp}`,
      ref: p.ref,
      op: 'eq',
      value: { kind: 'literal', value: v as (string | number | boolean | null) },
    }
  })

  const drillFilterTree: FilterGroup = {
    id: `drill-fg-${stamp}`,
    kind: 'group',
    conjunction: 'and',
    children: drillChildren,
  }

  return {
    version: 1,
    from: s.from,
    joins: s.joins,
    filterTree: drillFilterTree,
    groupBy: [],
    select: projectedColumns,  // Keep only the column projections; aggregations dropped.
    orderBy: s.orderBy,
    limit: 200,
  }
}
