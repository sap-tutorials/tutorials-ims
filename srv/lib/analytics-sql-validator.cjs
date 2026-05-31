const { Parser } = require('node-sql-parser')

const MAX_LEN = 16384
// node-sql-parser is stateless: a single Parser instance is safe to share across calls.
const parser = new Parser()

// Whitelisted HANA scalar/aggregate functions for analytics queries.
// Identifiers compared upper-case against AST function names. Any function
// not in this set causes validation to fail — closes the gap that previously
// let `os_command()` and friends slip through.
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  // date/time scalar
  'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
  'ADD_DAYS', 'ADD_MONTHS', 'ADD_YEARS',
  'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'NOW',
  // type conversion
  'TO_DATE', 'TO_VARCHAR', 'TO_CHAR', 'TO_NVARCHAR', 'TO_INTEGER', 'TO_BIGINT',
  'CAST',
  // null handling
  'COALESCE', 'NULLIF', 'IFNULL',
  // string scalar
  'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'SUBSTRING', 'SUBSTR', 'CONCAT', 'REPLACE',
  // conditional (note: CASE/WHEN/THEN/ELSE/END are AST nodes, not function calls — handled separately)
])

function validateSelect(sql, allowedTableNames) {
  if (!sql || !sql.trim()) {
    throw new Error('SQL is empty or missing')
  }
  if (sql.length > MAX_LEN) {
    throw new Error(`SQL length ${sql.length} exceeds maximum ${MAX_LEN}`)
  }
  // Deliberately strict: rejecting a literal '--' is safer than risking a missed comment injection.
  if (sql.includes('--') || sql.includes('/*')) {
    throw new Error('SQL comments are not allowed')
  }

  let ast
  try {
    ast = parser.astify(sql, { database: 'MySQL' })
  } catch (err) {
    if (/multiple|semicolon|EOF/i.test(err.message)) {
      throw new Error('Only a single statement is allowed')
    }
    throw new Error(`SQL parse error: ${err.message}`)
  }

  if (Array.isArray(ast)) {
    throw new Error('Only a single statement is allowed')
  }
  if (ast.type !== 'select') {
    throw new Error('Only SELECT statements are allowed')
  }

  const referenced = new Set()
  collectFromClause(ast, referenced)
  for (const t of referenced) {
    if (!allowedTableNames.has(t) && !allowedTableNames.has(t.toUpperCase())) {
      throw new Error(`Table '${t}' is not in the analytics allowlist`)
    }
  }

  // Function-call allowlist: traverse the entire AST and reject any function
  // not in ALLOWED_FUNCTIONS. Catches os_command, dbms_pipe.*, custom UDFs, etc.
  const calledFunctions = new Set()
  collectFunctions(ast, calledFunctions)
  for (const fn of calledFunctions) {
    if (!ALLOWED_FUNCTIONS.has(fn)) {
      throw new Error(`Function '${fn}' is not in the analytics function allowlist`)
    }
  }

  const isStar = Array.isArray(ast.columns) &&
    ast.columns.length === 1 &&
    ast.columns[0].expr &&
    ast.columns[0].expr.column === '*'
  const selectedColumns = (ast.columns === '*' || isStar || !Array.isArray(ast.columns))
    ? []
    : ast.columns.map(c => c.as || c.expr?.column).filter(Boolean)

  const reEmitted = parser.sqlify(ast, { database: 'Postgresql' })
  return { sql: reEmitted, selectedColumns }
}

function collectFromClause(ast, out) {
  if (ast.from && Array.isArray(ast.from)) {
    for (const f of ast.from) {
      if (f.table && typeof f.table === 'string') out.add(f.table)
      if (f.expr && f.expr.type === 'select') collectFromClause(f.expr, out)
    }
  }
  if (ast.where) collectSubqueries(ast.where, out)
  if (ast.having) collectSubqueries(ast.having, out)
  if (ast.columns && Array.isArray(ast.columns)) {
    for (const col of ast.columns) collectSubqueries(col, out)
  }
}

function collectSubqueries(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => collectSubqueries(n, out)); return }
  if (node.type === 'select') { collectFromClause(node, out); return }
  for (const v of Object.values(node)) collectSubqueries(v, out)
}

function collectFunctions(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => collectFunctions(n, out)); return }
  // node-sql-parser surfaces function calls as { type: 'function', name: { name: [{ value }] }, ... }
  // or { type: 'aggr_func', name: 'COUNT', ... } for aggregates.
  if (node.type === 'function' && node.name) {
    const fnName = Array.isArray(node.name?.name)
      ? node.name.name.map(n => n.value).join('.').toUpperCase()
      : (typeof node.name === 'string' ? node.name : '').toUpperCase()
    if (fnName) out.add(fnName)
  }
  if (node.type === 'aggr_func' && typeof node.name === 'string') {
    out.add(node.name.toUpperCase())
  }
  for (const v of Object.values(node)) collectFunctions(v, out)
}

module.exports = { validateSelect }
