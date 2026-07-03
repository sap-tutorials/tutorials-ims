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

// HANA reserved session-context and system pseudocolumns that node-sql-parser
// (MySQL dialect) parses as bare column_ref AST nodes rather than function
// calls. Without this denylist, `SELECT SYSTEM_USER FROM Users` slips past
// the function-allowlist walker below — see #906. Names stored upper-case
// and compared upper-case (HANA identifiers are case-insensitive). Sourcing:
// HANA SQL Reference (HANA Cloud QRC 2026-Q2), sections "Predefined Special
// Registers" and "Session Variables". Additions when SAP publishes new
// registers are one-line PRs against this set.
//
// NOTE: CURRENT_DATE / CURRENT_TIME / CURRENT_TIMESTAMP currently parse as
// `function` nodes (already gated by ALLOWED_FUNCTIONS above) — they are
// kept here defensively so a future parser-version bump that reclassifies
// them as column_ref doesn't silently re-open the gap.
const DENIED_BARE_IDENTIFIERS = new Set([
  'SYSTEM_USER', 'SESSION_USER', 'CURRENT_USER',
  'CURRENT_SCHEMA', 'CURRENT_CLIENT',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'CURRENT_UTCDATE', 'CURRENT_UTCTIME', 'CURRENT_UTCTIMESTAMP',
  'CURRENT_CONNECTION', 'CURRENT_OBJECT_SCHEMA', 'CURRENT_SITE_ID',
  'CURRENT_MVCC_SNAPSHOT_TIMESTAMP',
  'CURRENT_TRANSACTION_ISOLATION_LEVEL',
  'CURRENT_UPDATE_STATEMENT_SEQUENCE',
  'SYSUUID',
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

  // Bare-identifier denylist: HANA session-context names like SYSTEM_USER
  // parse as column_ref nodes, not function calls, and would otherwise slip
  // past the function-allowlist path above. See #906.
  const bareIdentifiers = new Set()
  collectBareIdentifiers(ast, bareIdentifiers)
  for (const id of bareIdentifiers) {
    if (DENIED_BARE_IDENTIFIERS.has(id)) {
      throw new Error(`Identifier '${id}' is a reserved session-context name and not allowed as a bare column reference`)
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

function collectBareIdentifiers(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => collectBareIdentifiers(n, out)); return }
  // A column_ref with no table qualifier is a bare identifier. Qualified
  // references (Users.SYSTEM_USER) are legitimate column reads and left alone.
  // node-sql-parser surfaces column_ref.column either as a bare string primitive
  // or as a nested object whose .expr.value holds the identifier; we handle
  // both without inspecting .expr.type (varies by parser version).
  if (node.type === 'column_ref' && (!node.table || node.table === '')) {
    const raw = typeof node.column === 'string'
      ? node.column
      : (node.column?.expr?.value ?? null)
    if (raw && typeof raw === 'string' && raw !== '*') {
      out.add(raw.toUpperCase())
    }
  }
  for (const v of Object.values(node)) collectBareIdentifiers(v, out)
}

module.exports = { validateSelect }
