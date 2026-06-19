// srv/lib/kg-sparql-client.js
// HANA Knowledge Graph Engine (KGE) SPARQL client wrapper.
//
// Source-of-truth references:
//   - PR 1 spike (#401) — established the canonical access pattern. The
//     `sparqlCall` reference implementation in scripts/spike/kg-probe.cjs
//     (lines ~153-180) is verbatim production contract.
//   - docs/developers/architecture/hana-kge-access.md — design rationale,
//     "Why no REST fallback?" discussion.
//   - docs/developers/operations/kg-grantor-setup.md — operator remediation
//     when SPARQL privileges are missing.
//
// What this module provides:
//   - sparqlExec(db, sparql)  — for SPARQL UPDATE / CLEAR / INSERT DATA / DELETE DATA.
//   - sparqlQuery(db, sparql) — for SPARQL SELECT / ASK / CONSTRUCT / DESCRIBE.
//   Both wrap the same `CALL SYS.SPARQL_EXECUTE(?, ?, response, headers)`
//   procedure invoked inside a `DO BEGIN … END` block over the existing
//   `cds.connect.to('db')` connection. The split is for *caller intent* (and
//   lets PR 5's named-query layer route correctly).
//
// SECURITY CONTRACT:
//   - All SPARQL is treated as opaque-but-trusted from the caller's
//     perspective. The CALLER is responsible for SPARQL-level validation.
//     PR 5's named-query layer enforces a query allow-list; ad-hoc callers
//     must NOT concatenate user-supplied data into the SPARQL body.
//   - The SPARQL body itself rides as a HANA bind parameter (typed NCLOB IN
//     param of the DO block), so SQL-injection at the JDBC layer is not
//     possible. SPARQL-injection is a separate concern handled upstream.
//
// Returned shape (mirrors the spike):
//   { response: string, headers: string, latencyMs: number }
//
// Errors raised:
//   - SparqlPrivilegeError — HANA code 258 or "User does not have SPARQL …"
//   - SparqlSyntaxError    — heuristic match on parser-error messages / codes
//   - SparqlTimeoutError   — Promise.race timeout (default 30s)
//   - any other DB error is re-thrown unchanged (with original .stack)

const DEFAULT_TIMEOUT_MS = 30_000;

// HANA error codes we care about (see hana-kge-access.md § Error codes).
const HANA_INSUFFICIENT_PRIVILEGE = 258;
const HANA_SPARQL_SYNTAX_HINTS = new Set([257, 261]);

// Heuristic regex for the "missing SPARQL QUERY/UPDATE" privilege message
// path. HANA emits these even when the numeric code is not 258 (e.g. when
// the privilege is missing on a sub-feature).
const PRIVILEGE_MSG_RE =
  /(?:User does not have|Insufficient privilege.*?)\s+SPARQL\s+(?:query|update)\b/i;

// Heuristic for SPARQL parser errors. SYS.SPARQL_EXECUTE surfaces these as
// generic SqlScript errors with a body that mentions "SPARQL" and "syntax"
// or "parse". Used as a last-resort match when the numeric code is not in
// HANA_SPARQL_SYNTAX_HINTS.
const SYNTAX_MSG_RE = /SPARQL.*?(?:syntax|parse|invalid query)/i;

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export class SparqlPrivilegeError extends Error {
  constructor(message, { cause, sparql, code } = {}) {
    super(message);
    this.name = 'SparqlPrivilegeError';
    if (cause !== undefined) this.cause = cause;
    this.sparql = truncate(sparql, 200);
    this.code = code;
    this.remediation =
      'See docs/developers/operations/kg-grantor-setup.md for granting ' +
      'SPARQL QUERY / SPARQL UPDATE via the HDI grantor flow.';
  }
}

export class SparqlSyntaxError extends Error {
  constructor(message, { cause, sparql, code } = {}) {
    super(message);
    this.name = 'SparqlSyntaxError';
    if (cause !== undefined) this.cause = cause;
    this.sparql = truncate(sparql, 200);
    this.code = code;
  }
}

export class SparqlTimeoutError extends Error {
  constructor(message, { sparql, timeoutMs } = {}) {
    super(message);
    this.name = 'SparqlTimeoutError';
    this.sparql = truncate(sparql, 200);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The DO-block shape, copied verbatim from the verified spike probe at
 * scripts/spike/kg-probe.cjs:153-180. The OUT params (response, headers)
 * are SELECTed back into a result-set so we can read them via cds.run()
 * regardless of which OUT-bind quirks the underlying driver has.
 */
const SPARQL_DO_BLOCK = `
DO (IN p_request NCLOB => ?, IN p_param NVARCHAR(5000) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL SYS.SPARQL_EXECUTE(:p_request, :p_param, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END
`.trim();

/**
 * Coerce the cds.run() return value to a single object. Different drivers
 * surface DO-block result-sets as a flat array, a nested array, or a single
 * object — handle all three uniformly. Verbatim shape coercion from the
 * spike probe.
 */
function coerceRow(rows) {
  const flat = Array.isArray(rows) ? rows.flat() : (rows ? [rows] : []);
  const row = flat[0] && typeof flat[0] === 'object' ? flat[0] : {};
  return row;
}

function classifyAndThrow(err, sparql) {
  // Some HANA drivers attach the numeric code on err.code; others on
  // err.sqlState or err.errorCode. Probe all common spots.
  const code = err && (err.code ?? err.errorCode ?? err.sqlCode);
  const numericCode = typeof code === 'number' ? code : Number(code);
  const message = (err && err.message) ? String(err.message) : String(err);

  if (numericCode === HANA_INSUFFICIENT_PRIVILEGE || PRIVILEGE_MSG_RE.test(message)) {
    throw new SparqlPrivilegeError(
      `SPARQL privilege missing: ${message}`,
      { cause: err, sparql, code: numericCode || undefined }
    );
  }

  if (HANA_SPARQL_SYNTAX_HINTS.has(numericCode) || SYNTAX_MSG_RE.test(message)) {
    throw new SparqlSyntaxError(
      `SPARQL syntax error: ${message}`,
      { cause: err, sparql, code: numericCode || undefined }
    );
  }

  // Unknown — re-throw original so the stack trace is preserved.
  throw err;
}

/**
 * Race a promise against a timer. Resolves to the promise's value, or
 * rejects with SparqlTimeoutError if the timer fires first.
 */
function withTimeout(promise, sparql, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new SparqlTimeoutError(
        `SPARQL exceeded ${timeoutMs}ms`,
        { sparql, timeoutMs }
      ));
    }, timeoutMs);
    // Unref so a hung query doesn't block process exit. Optional chaining
    // because the returned timer is platform-dependent.
    timer?.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Internal: shared invocation. Both sparqlExec and sparqlQuery delegate
 * here. The split between the two is purely for caller intent; HANA's
 * SYS.SPARQL_EXECUTE handles updates and queries through the same
 * procedure.
 *
 * @param {object} db
 * @param {string} sparql
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {string} [opts.acceptHeader='']  forwarded as the procedure's 2nd IN param
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
async function invoke(db, sparql, opts = {}) {
  if (typeof sparql !== 'string' || !sparql.trim()) {
    throw new TypeError(
      'sparql must be a non-empty string (got ' +
      (sparql === null ? 'null' : typeof sparql) + ')'
    );
  }
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('db must be a CDS service with a .run() method');
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const acceptHeader = typeof opts.acceptHeader === 'string' ? opts.acceptHeader : '';

  const t0 = Date.now();
  let rows;
  try {
    rows = await withTimeout(
      db.run(SPARQL_DO_BLOCK, [sparql, acceptHeader]),
      sparql,
      timeoutMs
    );
  } catch (err) {
    if (err instanceof SparqlTimeoutError) throw err;
    classifyAndThrow(err, sparql);
  }
  const latencyMs = Date.now() - t0;

  const row = coerceRow(rows);
  const response = row.RESPONSE ?? row.response ?? '';
  const headers = row.HEADERS ?? row.headers ?? '';
  return { response, headers, latencyMs };
}

/**
 * Execute a SPARQL UPDATE / CLEAR / INSERT DATA / DELETE DATA statement.
 *
 * @param {object} db        — CAP db service from cds.connect.to('db')
 * @param {string} sparql    — SPARQL update body
 * @param {object} [opts]
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
export function sparqlExec(db, sparql, opts) {
  return invoke(db, sparql, opts);
}

/**
 * Execute a SPARQL SELECT / ASK / CONSTRUCT / DESCRIBE query.
 *
 * @param {object} db        — CAP db service from cds.connect.to('db')
 * @param {string} sparql    — SPARQL query body
 * @param {object} [opts]
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
export function sparqlQuery(db, sparql, opts) {
  return invoke(db, sparql, opts);
}

// Test-only export for the DO-block constant. Not part of the public API.
export const __TESTING__ = {
  SPARQL_DO_BLOCK,
  DEFAULT_TIMEOUT_MS,
  coerceRow,
};
