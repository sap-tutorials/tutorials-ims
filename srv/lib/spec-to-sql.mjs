// Pure function: validated QuerySpec → HANA SQL.
// Output is deterministic and intentionally un-parenthesized at the top level
// so it composes with `runSelectQuery`'s wrapper: SELECT * FROM (...) t LIMIT N.
//
// Isomorphic — re-exported via Vite alias for the browser bundle in Phase 2.

const AGG_FN = {
  count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
}

function escapeLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number')  return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

function renderValue(value) {
  switch (value.kind) {
    case 'literal':
      return escapeLiteral(value.value)
    case 'list': {
      const items = (value.value || []).map(escapeLiteral).join(', ')
      return `(${items})`
    }
    case 'range':
      return `${escapeLiteral(value.value[0])} AND ${escapeLiteral(value.value[1])}`
    case 'relative':
      return String(Math.floor(Number(value.value)))
    case 'period':
      return value.value
    default:
      throw new Error(`spec-to-sql: unsupported value.kind '${value.kind}'`)
  }
}

function renderRef(ref) {
  return `${ref.alias}.${ref.column}`
}

function renderLeaf(leaf) {
  const ref = renderRef(leaf.ref)
  switch (leaf.op) {
    case 'eq':         return `${ref} = ${renderValue(leaf.value)}`
    case 'neq':        return `${ref} <> ${renderValue(leaf.value)}`
    case 'gt':         return `${ref} > ${renderValue(leaf.value)}`
    case 'gte':        return `${ref} >= ${renderValue(leaf.value)}`
    case 'lt':         return `${ref} < ${renderValue(leaf.value)}`
    case 'lte':        return `${ref} <= ${renderValue(leaf.value)}`
    case 'contains':   return `${ref} LIKE '%' || ${renderValue(leaf.value)} || '%'`
    case 'startsWith': return `${ref} LIKE ${renderValue(leaf.value)} || '%'`
    case 'endsWith':   return `${ref} LIKE '%' || ${renderValue(leaf.value)}`
    case 'in':         return `${ref} IN ${renderValue(leaf.value)}`
    case 'between':    return `${ref} BETWEEN ${renderValue(leaf.value)}`
    case 'isNull':     return `${ref} IS NULL`
    case 'sinceDays':
    case 'inLastDays':
      return `${ref} >= ADD_DAYS(CURRENT_DATE, -${renderValue(leaf.value)})`
    case 'inCurrent': {
      const period = renderValue(leaf.value).toUpperCase()
      const map = { DAY: '1', WEEK: '7', MONTH: '30', QUARTER: '90', YEAR: '365' }
      const days = map[period] || '1'
      return `${ref} >= ADD_DAYS(CURRENT_DATE, -${days})`
    }
    default:
      throw new Error(`spec-to-sql: unsupported op '${leaf.op}'`)
  }
}

function renderFilterTree(node) {
  if (!node) return null
  if (node.kind === 'group') {
    const inner = node.children.map(renderFilterTree).filter(Boolean)
    if (!inner.length) return null
    const joined = inner.join(node.conjunction === 'or' ? ' OR ' : ' AND ')
    const wrapped = `(${joined})`
    return node.negated ? `NOT ${wrapped}` : wrapped
  }
  const rendered = renderLeaf(node)
  return node.negated ? `NOT (${rendered})` : rendered
}

function renderSelectItem(item) {
  if (item.kind === 'column') {
    const ref = renderRef(item.ref)
    return item.alias ? `${ref} AS ${item.alias}` : ref
  }
  if (item.kind === 'aggregation') {
    const fn = AGG_FN[item.fn]
    const inner = item.ref === '*' ? '*' : renderRef(item.ref)
    const distinct = item.distinct ? 'DISTINCT ' : ''
    const expr = `${fn}(${distinct}${inner})`
    return item.alias ? `${expr} AS ${item.alias}` : expr
  }
  if (item.kind === 'expression') {
    return `${item.sql} AS ${item.alias}`
  }
  throw new Error(`spec-to-sql: unsupported select.kind '${item.kind}'`)
}

function deriveAutoGroupBy(select) {
  const hasAgg = select.some(s => s.kind === 'aggregation')
  if (!hasAgg) return []
  return select
    .filter(s => s.kind !== 'aggregation')
    .map(s => {
      if (s.kind === 'column')     return renderRef(s.ref)
      if (s.kind === 'expression') return s.sql
      return null
    })
    .filter(Boolean)
}

function specToSql(spec, sqlNames) {
  if (!spec || spec.version !== 1) throw new Error('spec-to-sql: unsupported spec version')

  const fromTable = sqlNames[spec.from.entity]
  if (!fromTable) throw new Error(`spec-to-sql: no SQL name for entity '${spec.from.entity}'`)

  const parts = []
  const selectClause = spec.select.map(renderSelectItem).join(', ')
  parts.push(`SELECT ${selectClause}`)
  parts.push(`FROM ${fromTable} ${spec.from.alias}`)

  for (const j of (spec.joins || [])) {
    const jTable = sqlNames[j.target.entity]
    if (!jTable) throw new Error(`spec-to-sql: no SQL name for joined entity '${j.target.entity}'`)
    const jKind = j.kind === 'left' ? 'LEFT JOIN' : 'INNER JOIN'
    const onLeft  = renderRef(j.on.leftRef)
    const onRight = renderRef(j.on.rightRef)
    parts.push(`${jKind} ${jTable} ${j.target.alias} ON ${onLeft} = ${onRight}`)
  }

  const where = renderFilterTree(spec.filterTree)
  if (where) parts.push(`WHERE ${where}`)

  const autoGroup = deriveAutoGroupBy(spec.select)
  const explicitGroup = (spec.groupBy || []).map(g => renderRef(g.ref))
  const allGroup = [...autoGroup, ...explicitGroup]
  if (allGroup.length) parts.push(`GROUP BY ${allGroup.join(', ')}`)

  if ((spec.orderBy || []).length) {
    const orderParts = spec.orderBy.map(o => {
      let ref
      if (o.by.kind === 'selectId') {
        const target = spec.select.find(s => s.id === o.by.id)
        if (!target) throw new Error(`spec-to-sql: orderBy references unknown selectId '${o.by.id}'`)
        ref = target.alias || (target.kind === 'column' ? renderRef(target.ref) : null)
        if (!ref) throw new Error(`spec-to-sql: orderBy.selectId target has no alias`)
      } else {
        ref = renderRef(o.by.ref)
      }
      return `${ref} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`
    })
    parts.push(`ORDER BY ${orderParts.join(', ')}`)
  }

  if (spec.limit) parts.push(`LIMIT ${Math.floor(spec.limit)}`)

  return parts.join(' ')
}

export { specToSql }
