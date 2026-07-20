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

  // #1233 (+ follow-up): validate every referenced table against the allowlist,
  // scope-aware. A CTE name is a LOCAL alias only within the scope where it is
  // in scope — NOT globally. Walking with a scope stack prevents a CTE named
  // after a forbidden table (anywhere, incl. nested subqueries) from masking a
  // real read of that table. See validateTableScopes.
  validateTableScopes(ast, allowedTableNames, new Set())

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

// #1233 follow-up: scope-aware table-allowlist validation.
//
// Walks the statement recursively carrying `inScope` — the set of CTE alias
// names visible AT THE CURRENT SCOPE (upper-cased). A referenced FROM table is
// allowed iff it is in the allowlist OR is an in-scope CTE alias. Because CTE
// visibility is tracked per scope (not globally), a CTE named after a forbidden
// table cannot mask a real read of that table in a sibling/outer/nested scope.
//
// Scope rules (SQL standard, verified against node-sql-parser MySQL dialect):
//   - The names declared in a scope's own `with` are visible to that scope's
//     FROM (and its set-op `_next` arms, since a WITH before a UNION applies to
//     the whole statement).
//   - A CTE BODY sees prior siblings; it sees its OWN name only if the CTE is
//     RECURSIVE (cte.recursive === true). For a non-recursive CTE, `FROM <own>`
//     inside its body is the REAL table and must be allowlisted.
//   - Subqueries / derived tables inherit the enclosing scope's visible names,
//     plus any CTEs they themselves declare.
// Fail-closed: anything not resolvable to an allowlisted table or an in-scope
// CTE alias throws.
function validateTableScopes(node, allowed, inScope) {
  if (!node || typeof node !== 'object') return

  // A `select` node introduces/extends CTE visibility for itself and its arms.
  if (node.type === 'select') {
    const siblings = cteEntries(node) // [{ name, recursive, body }]

    // 1) Validate each CTE body with the correct frame: prior siblings visible,
    //    own name visible only if recursive.
    for (let i = 0; i < siblings.length; i++) {
      const bodyScope = new Set(inScope)
      for (let j = 0; j < i; j++) bodyScope.add(siblings[j].name)
      if (siblings[i].recursive) bodyScope.add(siblings[i].name)
      validateTableScopes(siblings[i].body, allowed, bodyScope)
    }

    // 2) This scope (and its set-op arms) sees ALL its sibling CTE names.
    const selfScope = new Set(inScope)
    for (const s of siblings) selfScope.add(s.name)

    // 2a) Check this select's own FROM tables.
    if (Array.isArray(node.from)) {
      for (const f of node.from) {
        if (f.table && typeof f.table === 'string') {
          assertTableAllowed(f.table, allowed, selfScope)
        }
        // Derived table (subquery in FROM): recurse with the current scope
        // frame. node-sql-parser exposes the subquery select either directly on
        // f.expr (type:'select') or wrapped as f.expr.ast (with tableList/
        // columnList/ast/parentheses). Unwrap both shapes.
        const sub = f.expr && (f.expr.type === 'select' ? f.expr : f.expr.ast)
        if (sub && sub.type === 'select') {
          validateTableScopes(sub, allowed, selfScope)
        }
      }
    }

    // 2b) Subqueries in WHERE / HAVING / columns inherit this scope frame.
    for (const key of ['where', 'having', 'columns']) {
      descendSelects(node[key], allowed, selfScope)
    }

    // 2c) Set-operation arms (UNION/INTERSECT/EXCEPT) share this scope's CTEs.
    if (node._next && typeof node._next === 'object') {
      validateTableScopes(node._next, allowed, selfScope)
    }
    return
  }

  // Non-select node: descend looking for nested selects, preserving inScope.
  descendSelects(node, allowed, inScope)
}

// Find nested `select` nodes anywhere under `node` and validate them with the
// given scope frame. Does not itself resolve tables — that happens when a
// `select` node is reached by validateTableScopes.
function descendSelects(node, allowed, inScope) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) descendSelects(n, allowed, inScope)
    return
  }
  if (node.type === 'select') {
    validateTableScopes(node, allowed, inScope)
    return
  }
  for (const v of Object.values(node)) descendSelects(v, allowed, inScope)
}

// Extract CTE entries from a select node's WITH clause.
// Returns [{ name (upper-cased), recursive (bool), body (select node) }].
function cteEntries(node) {
  if (!node.with) return []
  const withArr = Array.isArray(node.with) ? node.with : [node.with]
  const out = []
  for (const cte of withArr) {
    const rawName = typeof cte?.name === 'string' ? cte.name : cte?.name?.value
    if (!rawName || typeof rawName !== 'string') continue
    const body = cte?.stmt?.ast || cte?.stmt
    out.push({ name: rawName.toUpperCase(), recursive: cte?.recursive === true, body })
  }
  return out
}

function assertTableAllowed(table, allowed, inScope) {
  const upper = table.toUpperCase()
  if (inScope.has(upper)) return // in-scope CTE alias — not a physical table
  if (allowed.has(table) || allowed.has(upper)) return
  throw new Error(`Table '${table}' is not in the analytics allowlist`)
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
