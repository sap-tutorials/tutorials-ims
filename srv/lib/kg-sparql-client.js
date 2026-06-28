// srv/lib/kg-sparql-client.js
// HANA Knowledge Graph Engine (KGE) SPARQL client wrapper.
//
// Source-of-truth references:
//   - PR 1 spike (#401) — established the canonical DO-block access pattern.
//   - PR 5 (#533, Tasks 1-5) — replaced raw SYS.SPARQL_EXECUTE calls with
//     four DEFINER-security procedures (KG_GRAPH_CLEAR, KG_GRAPH_INSERT,
//     KG_QUERY, KG_ADMIN_RUNSPARQL) to eliminate per-graph ACL collisions.
//   - Task 6 — this rewrite replaces sparqlExec/sparqlQuery with four typed
//     exports that call the procedures via per-procedure DO blocks.
//   - docs/developers/architecture/hana-kge-access.md — design rationale,
//     "Why no REST fallback?" discussion, "Why DEFINER procedures?" section.
//   - docs/developers/operations/kg-grantor-setup.md — operator remediation
//     when SPARQL privileges are missing.
//   - docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
//     — typed-client contract (§ "JS typed client").
//
// What this module provides (post-Task-6 public API):
//   - kgGraphClear({ db, graphIri, timeoutMs })
//   - kgGraphInsert({ db, graphIri, triples, timeoutMs })
//   - kgQuery({ db, queryName, params, overrideGraphIri, timeoutMs })
//   - kgAdminRunSparql({ db, sparql, isUpdate, timeoutMs })
//
// SPARQL_DO_BLOCK, sparqlExec, and sparqlQuery are DELETED. Callers that
// imported those names will break; Tasks 7-9 update those callers.
//
// SECURITY CONTRACT:
//   - All SPARQL is assembled inside the DEFINER procedures. The JS layer
//     never concatenates SPARQL strings from user input.
//   - Procedure IN params ride as HANA bind parameters in DO blocks —
//     SQL-injection at the JDBC layer is not possible.
//   - kgAdminRunSparql accepts an arbitrary SPARQL body, so its caller
//     (knowledge-graph-service.js) must ensure the body comes from a
//     trusted source (admin-only endpoint, XSUAA role check).
//
// Returned shape (all four exports):
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

// IRI shape: http(s) scheme with safe chars, or urn: scheme with safe chars.
// Mirrors the LIKE_REGEXPR checks inside KG_GRAPH_CLEAR / KG_GRAPH_INSERT.
const IRI_RE = /^(?:https?:\/\/[A-Za-z0-9./_-]+|urn:[A-Za-z0-9:_-]+)$/;

// Hard cap on NCLOB inputs (triples, sparql).
const MAX_NCLOB = 16 * 1024 * 1024; // 16 MB

// ---------------------------------------------------------------------------
// Per-procedure DO blocks
// ---------------------------------------------------------------------------
// @cap-js/hana does not bind OUT params via db.run('CALL …'). The DO-block
// pattern converts OUT params to a SELECT result-set that db.run() can read.
// Each constant matches the IN-param shape of its procedure exactly.
// Cross-checked against db/src/procedures/KG_GRAPH_CLEAR.hdbprocedure,
// KG_GRAPH_INSERT.hdbprocedure, KG_QUERY.hdbprocedure,
// KG_ADMIN_RUNSPARQL.hdbprocedure.

const DO_KG_GRAPH_CLEAR = `DO (IN p NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_CLEAR(:p, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

const DO_KG_GRAPH_INSERT = `DO (IN p NVARCHAR(500) => ?, IN t NCLOB => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_INSERT(:p, :t, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

// KG_QUERY has 5 IN params: query_name, p1, p2, p3, override_graph_iri.
const DO_KG_QUERY = `DO (IN qn NVARCHAR(50) => ?, IN p1 NVARCHAR(500) => ?, IN p2 NVARCHAR(500) => ?, IN p3 NVARCHAR(500) => ?, IN ogi NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_QUERY(:qn, :p1, :p2, :p3, :ogi, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

const DO_KG_ADMIN_RUNSPARQL = `DO (IN s NCLOB => ?, IN f NVARCHAR(1) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_ADMIN_RUNSPARQL(:s, :f, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;

// ---------------------------------------------------------------------------
// Query param shapes
// ---------------------------------------------------------------------------
// Defines the allowed queryName values for kgQuery, their required keys, and
// the positional order in which those keys map to p1/p2/p3 in KG_QUERY.

const QUERY_PARAM_SHAPES = Object.freeze({
  NEIGHBORHOOD:        Object.freeze({ required: ['slug'],               order: ['slug'] }),
  PATH_BETWEEN:        Object.freeze({ required: ['fromSlug', 'toSlug'], order: ['fromSlug', 'toSlug'] }),
  CONCEPTS_FOR_USER:   Object.freeze({ required: ['userId'],             order: ['userId'] }),
  // EXPLORE_GRAPH_BULK (issue #446) takes no per-query parameters; the
  // optional overrideGraphIri (passed separately to kgQuery()) still works.
  EXPLORE_GRAPH_BULK:  Object.freeze({ required: [],                     order: [] }),
});

// ---------------------------------------------------------------------------
// Error classes (unchanged from pre-Task-6)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared internal helpers (unchanged from pre-Task-6)
// ---------------------------------------------------------------------------

/**
 * Coerce the cds.run() return value to a single object. Different drivers
 * surface DO-block result-sets as a flat array, a nested array, or a single
 * object — handle all three uniformly. Verbatim shape coercion from the
 * spike probe.
 */
function coerceRow(rows) {
  // The @cap-js/hana driver wraps DO-block results as { changes: [{}, [rows]] }.
  // The first `changes[0]` is the DO statement itself (no rows); `changes[1]`
  // is the SELECT statement's row array. Unwrap to that array first, then
  // fall through to the legacy flat-array path for tests that pass a plain
  // [{RESPONSE: ...}] shape.
  //
  // (Latent bug from PR #555: original coerceRow used Array.isArray → false
  // for the {changes:...} object → wrapped in [rows] → looked for .RESPONSE
  // on the wrapper → got undefined → empty string. Caught when Phase 2's
  // getConceptsForUser actually consumed the .response field. See #445.)
  if (rows && typeof rows === 'object' && !Array.isArray(rows) && Array.isArray(rows.changes)) {
    const selectRows = rows.changes[1];
    if (Array.isArray(selectRows) && selectRows[0] && typeof selectRows[0] === 'object') {
      return selectRows[0];
    }
  }
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
    // Unref so a hung query doesn't block process exit.
    timer?.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Validators (synchronous, throw before DB call)
// ---------------------------------------------------------------------------

function validateIri(name, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string (got ${value === null ? 'null' : typeof value})`);
  }
  if (value.length < 1 || value.length > 500) {
    throw new RangeError(`${name} length must be 1-500 chars (got ${value.length})`);
  }
  if (!IRI_RE.test(value)) {
    throw new TypeError(`${name} must match the IRI shape (http(s)://… or urn:…)`);
  }
}

function validateNclob(name, value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new RangeError(`${name} must be non-empty`);
  }
  if (value.length > MAX_NCLOB) {
    throw new RangeError(`${name} exceeds ${MAX_NCLOB} chars`);
  }
}

// ---------------------------------------------------------------------------
// Private: shared procedure call
// ---------------------------------------------------------------------------

async function callProcedure(db, doBlock, inArgs, opts = {}) {
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('db must be a CDS service with a .run() method');
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const sparqlForLog = opts.sparqlForLog || '';

  const t0 = Date.now();
  let rows;
  try {
    rows = await withTimeout(db.run(doBlock, inArgs), sparqlForLog, timeoutMs);
  } catch (err) {
    if (err instanceof SparqlTimeoutError) throw err;
    classifyAndThrow(err, sparqlForLog);
  }
  const latencyMs = Date.now() - t0;
  const row = coerceRow(rows);
  const response = row.RESPONSE ?? row.response ?? '';
  const headers = row.HEADERS ?? row.headers ?? '';
  return { response, headers, latencyMs };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Clear all triples from a named graph using the KG_GRAPH_CLEAR DEFINER proc.
 *
 * @param {object} opts
 * @param {object}  opts.db          — CAP db service from cds.connect.to('db')
 * @param {string}  opts.graphIri    — IRI of the graph to clear (http(s):// or urn:)
 * @param {number}  [opts.timeoutMs] — override the default 30s timeout
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
export async function kgGraphClear({ db, graphIri, timeoutMs } = {}) {
  validateIri('graphIri', graphIri);
  return callProcedure(db, DO_KG_GRAPH_CLEAR, [graphIri], {
    timeoutMs,
    sparqlForLog: `CLEAR GRAPH <${graphIri}>`,
  });
}

/**
 * Insert triples into a named graph using the KG_GRAPH_INSERT DEFINER proc.
 *
 * @param {object} opts
 * @param {object}  opts.db          — CAP db service from cds.connect.to('db')
 * @param {string}  opts.graphIri    — IRI of the graph to insert into
 * @param {string}  opts.triples     — N-Triples body (non-empty, max 16MB)
 * @param {number}  [opts.timeoutMs] — override the default 30s timeout
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
export async function kgGraphInsert({ db, graphIri, triples, timeoutMs } = {}) {
  validateIri('graphIri', graphIri);
  validateNclob('triples', triples);
  return callProcedure(db, DO_KG_GRAPH_INSERT, [graphIri, triples], {
    timeoutMs,
    sparqlForLog: `INSERT DATA { GRAPH <${graphIri}> { … } }`,
  });
}

/**
 * Execute a named SPARQL query via the KG_QUERY DEFINER proc.
 *
 * @param {object} opts
 * @param {object}  opts.db                  — CAP db service
 * @param {string}  opts.queryName            — one of NEIGHBORHOOD / PATH_BETWEEN / CONCEPTS_FOR_USER / EXPLORE_GRAPH_BULK
 * @param {object}  opts.params               — per-query typed parameters (see QUERY_PARAM_SHAPES)
 * @param {string}  [opts.overrideGraphIri]   — when set, replaces the production graph IRI (used by hybrid tests)
 * @param {number}  [opts.timeoutMs]          — override the default 30s timeout
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
export async function kgQuery({ db, queryName, params, overrideGraphIri, timeoutMs } = {}) {
  if (typeof queryName !== 'string' || !(queryName in QUERY_PARAM_SHAPES)) {
    throw new TypeError(
      `queryName must be one of: ${Object.keys(QUERY_PARAM_SHAPES).join(', ')} (got ${String(queryName)})`
    );
  }
  if (!params || typeof params !== 'object') {
    throw new TypeError('params must be an object');
  }

  const shape = QUERY_PARAM_SHAPES[queryName];
  const got = Object.keys(params);
  const missing = shape.required.filter(k => !(k in params));
  const extra = got.filter(k => !shape.required.includes(k));
  if (missing.length) throw new TypeError(`params missing keys: ${missing.join(', ')}`);
  if (extra.length) throw new TypeError(`params has unexpected keys: ${extra.join(', ')}`);

  for (const k of shape.required) {
    const v = params[k];
    if (typeof v !== 'string' || v.length === 0 || v.length > 500) {
      throw new TypeError(`params.${k} must be a string of 1-500 chars`);
    }
  }

  if (overrideGraphIri !== undefined && overrideGraphIri !== null) {
    validateIri('overrideGraphIri', overrideGraphIri);
  }

  // Build the 5 positional args: queryName, p1, p2, p3, overrideGraphIri.
  // p1..p3 come from shape.order; unused slots are null.
  const ordered = shape.order.map(k => params[k]);
  const p1 = ordered[0] ?? null;
  const p2 = ordered[1] ?? null;
  const p3 = ordered[2] ?? null;
  const ogi = overrideGraphIri ?? null;

  return callProcedure(db, DO_KG_QUERY, [queryName, p1, p2, p3, ogi], {
    timeoutMs,
    sparqlForLog: `KG_QUERY(${queryName})`,
  });
}

/**
 * Execute an arbitrary SPARQL statement via the KG_ADMIN_RUNSPARQL DEFINER proc.
 * Admin-only: callers must enforce XSUAA role check before invoking this.
 *
 * @param {object} opts
 * @param {object}  opts.db          — CAP db service
 * @param {string}  opts.sparql      — SPARQL body (non-empty, max 16MB)
 * @param {boolean} opts.isUpdate    — true for UPDATE/INSERT/DELETE/CLEAR; false for SELECT/ASK
 * @param {number}  [opts.timeoutMs] — override the default 30s timeout
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
export async function kgAdminRunSparql({ db, sparql, isUpdate, timeoutMs } = {}) {
  validateNclob('sparql', sparql);
  if (typeof isUpdate !== 'boolean') {
    throw new TypeError(`isUpdate must be a boolean (got ${typeof isUpdate})`);
  }
  const flag = isUpdate ? 'Y' : 'N';
  return callProcedure(db, DO_KG_ADMIN_RUNSPARQL, [sparql, flag], {
    timeoutMs,
    sparqlForLog: sparql,
  });
}

// Test-only exports. Not part of the public API.
// IRI_RE and QUERY_PARAM_SHAPES are exported for validator unit tests.
// coerceRow and DEFAULT_TIMEOUT_MS are retained for shape-coercion tests.
export const __TESTING__ = {
  IRI_RE,
  QUERY_PARAM_SHAPES,
  DEFAULT_TIMEOUT_MS,
  coerceRow,
};
