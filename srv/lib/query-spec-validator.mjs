// Pure-function validator for QuerySpec (the canonical state shape produced
// by the chip builder and by Joule's generateAnalyticsQuery tool). Returns
// { errors: [{ chipId, message }] } — empty array means valid. Does not call
// any DB and does not generate SQL.
//
// Isomorphic — re-exported via Vite alias for the browser bundle in Phase 2.

const VALID_FNS = new Set(['count', 'sum', 'avg', 'min', 'max'])
const MAX_GROUP_DEPTH = 4

const OP_VALUE_KIND = {
  eq:'literal', neq:'literal', gt:'literal', gte:'literal', lt:'literal', lte:'literal',
  contains:'literal', startsWith:'literal', endsWith:'literal',
  in:'list',
  between:'range',
  isNull:'literal',
  sinceDays:'relative', inLastDays:'relative',
  inCurrent:'period',
}

const STRING_TYPES   = new Set(['cds.String', 'cds.LargeString'])
const NUMERIC_TYPES  = new Set(['cds.Integer', 'cds.Decimal', 'cds.Double', 'cds.Int64'])
const TEMPORAL_TYPES = new Set(['cds.Date', 'cds.DateTime', 'cds.Timestamp'])

function classifyType(t) {
  if (NUMERIC_TYPES.has(t)) return 'numeric'
  if (TEMPORAL_TYPES.has(t)) return 'temporal'
  if (STRING_TYPES.has(t))  return 'string'
  return 'other'
}

const OP_TYPE_OK = {
  eq: ['string','numeric','temporal','other'],
  neq:['string','numeric','temporal','other'],
  gt: ['numeric','temporal'],
  gte:['numeric','temporal'],
  lt: ['numeric','temporal'],
  lte:['numeric','temporal'],
  contains: ['string'], startsWith:['string'], endsWith:['string'],
  in: ['string','numeric','other'],
  between:    ['numeric','temporal'],
  isNull:     ['string','numeric','temporal','other'],
  sinceDays:  ['temporal'], inLastDays:['temporal'], inCurrent:['temporal'],
}

function validateQuerySpec(spec, entityMap) {
  const errors = []
  const push = (chipId, message) => errors.push({ chipId, message })

  if (!spec || typeof spec !== 'object') return { errors: [{ chipId: null, message: 'spec must be an object' }] }
  if (spec.version !== 1) return { errors: [{ chipId: null, message: 'unsupported QuerySpec version' }] }

  const aliasMap = new Map()
  if (!spec.from || !spec.from.entity || !spec.from.alias) {
    push(null, 'spec.from is required (entity + alias)')
  } else if (!entityMap.has(spec.from.entity)) {
    push(null, `unknown entity '${spec.from.entity}' in from`)
  } else {
    aliasMap.set(spec.from.alias, entityMap.get(spec.from.entity))
  }

  for (const j of (spec.joins || [])) {
    if (!j.target || !entityMap.has(j.target.entity)) {
      push(j.id, `unknown entity '${j.target?.entity}' in join`)
      continue
    }
    if (aliasMap.has(j.target.alias)) {
      push(j.id, `duplicate alias '${j.target.alias}' in join`)
      continue
    }
    // ON refs validated against aliasMap as it stands BEFORE this join is added,
    // PLUS the to-be-introduced alias (rightRef typically points to it).
    const checkRef = (ref, label) => {
      const knownAlias = aliasMap.has(ref.alias) || ref.alias === j.target.alias
      if (!knownAlias) {
        push(j.id, `join ON ${label} references unknown alias '${ref.alias}'`)
        return false
      }
      const e = aliasMap.get(ref.alias) || entityMap.get(j.target.entity)
      if (!e.columns.has(ref.column)) {
        push(j.id, `join ON ${label} references unknown column '${ref.column}' on alias '${ref.alias}'`)
        return false
      }
      return true
    }
    if (j.on) {
      checkRef(j.on.leftRef, 'leftRef')
      checkRef(j.on.rightRef, 'rightRef')
    } else {
      push(j.id, 'join is missing ON condition')
    }
    aliasMap.set(j.target.alias, entityMap.get(j.target.entity))
  }

  const checkColumnRef = (ref, chipId, label) => {
    if (!aliasMap.has(ref.alias)) {
      push(chipId, `${label}: unknown alias '${ref.alias}'`)
      return null
    }
    const ent = aliasMap.get(ref.alias)
    if (!ent.columns.has(ref.column)) {
      push(chipId, `${label}: unknown column '${ref.column}' on alias '${ref.alias}'`)
      return null
    }
    return ent.columns.get(ref.column)
  }

  function walkFilter(node, depth) {
    if (!node) return
    if (depth > MAX_GROUP_DEPTH) {
      push(node.id, `filter group exceeds max nesting depth ${MAX_GROUP_DEPTH}`)
      return
    }
    if (node.kind === 'group') {
      if (!Array.isArray(node.children) || node.children.length === 0) {
        push(node.id, 'filter group must have at least one child')
        return
      }
      if (!['and','or'].includes(node.conjunction)) {
        push(node.id, `invalid conjunction '${node.conjunction}'`)
      }
      node.children.forEach(c => walkFilter(c, depth + 1))
      return
    }
    const colMeta = checkColumnRef(node.ref, node.id, 'filter ref')
    const expectedKind = OP_VALUE_KIND[node.op]
    if (!expectedKind) {
      push(node.id, `unknown filter op '${node.op}'`)
      return
    }
    if (!node.value || node.value.kind !== expectedKind) {
      push(node.id, `op '${node.op}' requires value.kind '${expectedKind}'`)
    }
    if (colMeta) {
      const cls = classifyType(colMeta.type)
      const okTypes = OP_TYPE_OK[node.op] || []
      if (!okTypes.includes(cls)) {
        push(node.id, `op '${node.op}' not valid for column type '${colMeta.type}' (classified as ${cls})`)
      }
    }
  }
  walkFilter(spec.filterTree, 1)

  for (const g of (spec.groupBy || [])) {
    checkColumnRef(g.ref, g.id, 'groupBy')
  }

  if (!Array.isArray(spec.select) || spec.select.length === 0) {
    push(null, 'select must have at least one chip')
  } else {
    for (const s of spec.select) {
      if (s.kind === 'column') {
        checkColumnRef(s.ref, s.id, 'select column')
      } else if (s.kind === 'aggregation') {
        if (!VALID_FNS.has(s.fn)) {
          push(s.id, `aggregation fn '${s.fn}' is not valid (allowed: ${[...VALID_FNS].join(', ')})`)
        }
        if (s.ref !== '*' && s.ref) {
          checkColumnRef(s.ref, s.id, 'aggregation column')
        }
      } else if (s.kind === 'expression') {
        if (!s.alias) push(s.id, 'expression chip requires alias')
        if (typeof s.sql !== 'string' || !s.sql.trim()) push(s.id, 'expression chip requires sql')
      } else {
        push(s.id, `unknown select kind '${s.kind}'`)
      }
    }
  }

  for (const o of (spec.orderBy || [])) {
    if (o.by?.kind === 'columnRef') {
      checkColumnRef(o.by.ref, o.id, 'orderBy')
    } else if (o.by?.kind === 'selectId') {
      if (!spec.select.some(s => s.id === o.by.id)) {
        push(o.id, `orderBy references unknown selectId '${o.by.id}'`)
      }
    } else {
      push(o.id, `orderBy must reference a select id or a columnRef`)
    }
    if (!['asc','desc'].includes(o.direction)) {
      push(o.id, `orderBy direction must be 'asc' or 'desc'`)
    }
  }

  if (spec.limit !== null && spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 100000) {
      push(null, `limit must be a positive integer <= 100000 or null`)
    }
  }

  return { errors }
}

export { validateQuerySpec }
