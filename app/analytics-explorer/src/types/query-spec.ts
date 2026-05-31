// QuerySpec — canonical state shape for the analytics builder. Matches the
// JSDoc shape consumed by srv/lib/query-spec-validator.mjs and srv/lib/spec-to-sql.mjs.
//
// Keep this file in sync with the validator's OP_VALUE_KIND / OP_TYPE_OK
// constants; the validator's own tests guard the runtime-shape contract,
// and these TS types match it 1:1.

export interface QuerySpec {
  version: 1
  from: TableRef
  joins: Join[]
  filterTree: FilterNode | null
  groupBy: GroupKey[]
  select: SelectItem[]
  orderBy: OrderClause[]
  limit: number | null
}

export interface TableRef {
  entity: string
  alias: string
}

export interface Join {
  id: string
  kind: 'inner' | 'left'
  target: TableRef
  on: { leftRef: ColumnRef; rightRef: ColumnRef }
}

export interface ColumnRef {
  alias: string
  column: string
}

export type FilterNode = Filter | FilterGroup

export interface Filter {
  id: string
  ref: ColumnRef
  op: FilterOp
  value: FilterValue
  negated?: boolean
}

export interface FilterGroup {
  id: string
  kind: 'group'
  conjunction: 'and' | 'or'
  negated?: boolean
  children: FilterNode[]
}

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'contains' | 'startsWith' | 'endsWith'
  | 'between' | 'isNull'
  | 'sinceDays' | 'inLastDays' | 'inCurrent'

export type FilterValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'list'; value: (string | number)[] }
  | { kind: 'range'; value: [string | number, string | number] }
  | { kind: 'relative'; value: number; unit?: 'days' | 'months' | 'years' }
  | { kind: 'period'; value: 'day' | 'week' | 'month' | 'quarter' | 'year' }

export interface GroupKey {
  id: string
  ref: ColumnRef
}

export type SelectItem =
  | { kind: 'column'; id: string; ref: ColumnRef; alias?: string }
  | { kind: 'aggregation'; id: string; fn: AggFn; ref: ColumnRef | '*'; distinct?: boolean; alias?: string }
  | {
      kind: 'expression'
      id: string
      sql: string
      alias: string
      referencedAliases: string[]
    }

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max'

export interface OrderClause {
  id: string
  by: { kind: 'selectId'; id: string } | { kind: 'columnRef'; ref: ColumnRef }
  direction: 'asc' | 'desc'
}

// ─── Validation envelope (returned by query-spec-validator.mjs) ──────────
export interface ValidationIssue {
  chipId: string | null
  message: string
}

export interface ValidationResult {
  errors: ValidationIssue[]
}

// ─── Helpers for chip components ─────────────────────────────────────────
export function isFilterGroup(node: FilterNode | null | undefined): node is FilterGroup {
  return !!node && (node as FilterGroup).kind === 'group'
}

export function isFilterLeaf(node: FilterNode | null | undefined): node is Filter {
  return !!node && (node as FilterGroup).kind !== 'group'
}
