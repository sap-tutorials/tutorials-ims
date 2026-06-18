/* eslint-disable no-console */
/**
 * kg-probe.cjs — HANA Knowledge Graph Engine (KGE) spike probe.
 *
 * PR 1 of 8 (issue #381). Throwaway diagnostic script.
 *
 * Run via:
 *   cf login                      # ensure DEV space
 *   npx cds bind --exec --profile hybrid -- node scripts/spike/kg-probe.cjs
 *
 * Goal: confirm that HANA Cloud's KGE / SPARQL engine can be driven from CAP
 * via the canonical `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)` stored procedure
 * over the existing `cds.connect.to('db')` connection.
 *
 * --------------------------------------------------------------------------
 * SPEC AMENDMENT (2026-06-17)
 *
 * The original PR 1 spec hypothesised that one of three SQL-extension forms
 * would work:
 *   1. SPARQL EXECUTE '<query>'
 *   2. EXECUTE 'SPARQL <query>'
 *   3. EXECUTE 'SPARQL <query>' AS SPARQL
 *
 * All three were rejected by HANA SQL parsing with errors of the form
 * `sql syntax error: incorrect syntax near "SPARQL"` / `near "EXECUTE"`.
 *
 * The verified access path is the stored procedure `SYS.SPARQL_EXECUTE`:
 *   PROCEDURE SYS.SPARQL_EXECUTE (
 *     REQUEST   NCLOB           IN,    -- SPARQL string
 *     PARAMETER NVARCHAR(5000)  IN,    -- accept-header / format hint, may be ''
 *     RESPONSE  NCLOB           OUT,   -- SPARQL result body
 *     HEADERS   NVARCHAR(5000)  OUT    -- response headers
 *   )
 *
 * See `docs/developers/architecture/hana-kge-access.md` for the full write-up.
 * --------------------------------------------------------------------------
 *
 * The probe operates on a SPIKE-ONLY named graph
 *   <https://developers.sap.com/kg/spike-probe>
 * which is intentionally distinct from the future production graph
 *   <https://developers.sap.com/kg/tutorials>
 * so this script can never touch real data.
 *
 * NOTE on quoting: SPARQL bodies are passed as bind parameters via the OUT-
 * param `DO BEGIN … END` block, so single quotes inside the SPARQL would be
 * harmless to the SQL layer. The production client (srv/lib/kg-sparql-client.js,
 * to be written in PR 4) MUST still validate/escape user-supplied IRIs and
 * literals at the SPARQL level before they reach the procedure.
 */

'use strict';

const cds = require('@sap/cds');

const SPIKE_GRAPH = '<https://developers.sap.com/kg/spike-probe>';

// Sentinel thrown by timedSparql when a privilege error is detected.
// Lets main()'s catch handler distinguish "expected blocker, drain & exit 2"
// from "unexpected fatal, log stack & exit 1".
const PRIVILEGE_BLOCKER = Symbol('privilege-blocker');

// Use full IRIs (not prefixed names) to avoid PN_LOCAL parser variance.
// HANA's SPARQL parser is strict about `/` inside prefixed names; angle-bracket
// IRIs are unambiguously valid across all SPARQL 1.1 implementations.
const T_A   = '<http://example.com/t/a>';
const C_1   = '<http://example.com/c/1>';
const C_2   = '<http://example.com/c/2>';
const TEACHES  = '<http://example.com/teaches>';
const REQUIRES = '<http://example.com/requires>';

const SPARQL_CLEAR = `CLEAR GRAPH ${SPIKE_GRAPH}`;

const SPARQL_INSERT = `
INSERT DATA {
  GRAPH ${SPIKE_GRAPH} {
    ${T_A} ${TEACHES} ${C_1} .
    ${T_A} ${TEACHES} ${C_2} .
    ${C_2} ${REQUIRES} ${C_1} .
  }
}
`.trim();

// 2-hop: tutorial t/a teaches ?known; some ?adv requires ?known.
// Spec phrasing: "for tutorial t/a, find concepts (?adv) that require any concept (?known)
// the tutorial teaches". The prerequisite is just ?known itself, so we project it directly
// rather than re-binding it under another name.
const SPARQL_SELECT = `
SELECT ?adv ?known
FROM ${SPIKE_GRAPH}
WHERE {
  ${T_A} ${TEACHES} ?known .
  ?adv ${REQUIRES} ?known .
}
`.trim();

const PRIVILEGE_ERROR_RE =
  /(?:User does not have|Insufficient privilege.*?)\s+SPARQL\s+(query|update)\b/i;

// HANA driver attaches a numeric error code; insufficient-privilege is 258.
const HANA_INSUFFICIENT_PRIVILEGE_CODE = 258;

/**
 * Detects the privilege blocker and prints a clear remediation message.
 * Returns true if handled, false otherwise.
 *
 * Detection is two-pronged:
 *   1. err.code === 258 (HANA insufficient-privilege) — authoritative.
 *   2. PRIVILEGE_ERROR_RE — captures the QUERY/UPDATE discriminator from
 *      the message text. Brittle to wording changes, so it's a fallback.
 *
 * If (1) matches but (2) doesn't, we still treat it as a privilege blocker
 * but log without the QUERY/UPDATE discriminator.
 */
function handlePrivilegeError(label, err) {
  const msg = err && err.message ? err.message : String(err);
  const code = err && err.code;
  const m = msg.match(PRIVILEGE_ERROR_RE);
  const isPrivilegeError = m || code === HANA_INSUFFICIENT_PRIVILEGE_CODE;
  if (!isPrivilegeError) return false;

  const which = m ? m[1].toUpperCase() : null; // QUERY | UPDATE | null
  console.error('');
  if (which) {
    console.error(`[probe] PRIVILEGE BLOCKER: this user lacks SPARQL ${which}.`);
  } else {
    console.error('[probe] PRIVILEGE BLOCKER: this user lacks SPARQL privileges (insufficient privilege error 258).');
  }
  console.error('[probe] Remediation (HDI-canonical flow — do NOT grant directly to the runtime user):');
  console.error('[probe]   1. Ensure a grantor user with "SPARQL QUERY"/"SPARQL UPDATE"');
  console.error('[probe]      WITH ADMIN OPTION exists (DBADMIN creates this).');
  console.error('[probe]   2. Add a .hdbgrants artefact granting these to the container\'s');
  console.error('[probe]      default_access_role; bind grantor service to the HDI deployer.');
  console.error('[probe]   3. Redeploy the HDI module.');
  console.error('[probe] See docs/developers/architecture/hana-kge-access.md § Privileges required.');
  console.error('[probe] Then re-run this probe.');
  console.error('');
  console.error(`[probe] (failure observed in step: ${label})`);
  return true;
}

/**
 * Wrapper around the SYS.SPARQL_EXECUTE stored procedure.
 *
 * Uses a `DO BEGIN … END` block so we can SELECT the OUT params back as a
 * regular result-set — that side-steps any cds-version variance in how
 * `db.run('CALL …')` surfaces OUT bind parameters.
 *
 * @param {object} db        — CAP db service from cds.connect.to('db')
 * @param {string} request   — SPARQL string (CLEAR / INSERT DATA / SELECT / …)
 * @param {string} parameter — accept-header / format hint; '' for default
 * @returns {Promise<{response:string, headers:string, latencyMs:number}>}
 */
async function sparqlCall(db, request, parameter = '') {
  // HANA SQLScript binds parameters at the DO block's signature, not via
  // bare `?` inside the block body. Declare typed IN parameters and
  // reference them by name inside the procedure call.
  //
  // The OUT params (response, headers) are SELECTed back into a result-set
  // so we can read them via cds without depending on driver OUT-bind support.
  const sql = `
DO (IN p_request NCLOB => ?, IN p_param NVARCHAR(5000) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL SYS.SPARQL_EXECUTE(:p_request, :p_param, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END
`.trim();

  const t0 = Date.now();
  const rows = await db.run(sql, [request, parameter]);
  const latencyMs = Date.now() - t0;

  // `DO BEGIN … END` returns the SELECT's rows as the procedure result.
  // Different cds drivers may surface this as a flat array, a nested array,
  // or a single object — flatten once, then pick the first object-shaped
  // entry. This handles all observed driver shapes uniformly.
  const flat = Array.isArray(rows) ? rows.flat() : (rows ? [rows] : []);
  const row = flat[0] && typeof flat[0] === 'object' ? flat[0] : {};

  const response = row.RESPONSE ?? row.response ?? '';
  const headers  = row.HEADERS  ?? row.headers  ?? '';
  return { response, headers, latencyMs };
}

async function timedSparql(label, db, request) {
  try {
    const { response, headers, latencyMs } = await sparqlCall(db, request);
    console.log(`[probe] ${label}: ok in ${latencyMs} ms`);
    return { ok: true, ms: latencyMs, response, headers };
  } catch (err) {
    if (handlePrivilegeError(label, err)) {
      // Privilege blocker — no point continuing. Don't hard-exit here:
      // we want main()'s catch to drain the cds connection cleanly first.
      process.exitCode = 2;
      throw PRIVILEGE_BLOCKER;
    }
    const msg = err && err.message ? err.message : String(err);
    console.error(`[probe] ${label}: FAILED — ${msg}`);
    throw err;
  }
}

async function main() {
  console.log('[probe] connecting to db via cds.connect.to("db")…');
  const db = await cds.connect.to('db');
  console.log('[probe] connected. db.kind =', db.kind || '(unknown)');
  if (db.kind !== 'hana') {
    console.error(`[probe] WRONG DRIVER: db.kind is "${db.kind}", expected "hana".`);
    console.error('[probe] You probably forgot --profile hybrid. Try:');
    console.error('[probe]   npx cds bind --exec --profile hybrid -- node scripts/spike/kg-probe.cjs');
    process.exitCode = 3;
    throw new Error('wrong-driver');
  }
  console.log('[probe] access path: CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)');

  const timings = {};

  // --- Step 1: initial CLEAR ---
  const c0 = await timedSparql('CLEAR GRAPH (initial)', db, SPARQL_CLEAR);
  timings.clear_initial = { ms: c0.ms, ok: c0.ok };

  // --- Step 2: INSERT 3 sample triples ---
  const ins = await timedSparql('INSERT DATA (3 triples)', db, SPARQL_INSERT);
  timings.insert = { ms: ins.ms, ok: ins.ok };

  // --- Step 3: 2-hop SELECT ---
  const sel = await timedSparql('SELECT (2-hop)', db, SPARQL_SELECT);
  timings.select = { ms: sel.ms, ok: sel.ok };

  console.log('[probe] SELECT response (raw):');
  console.log(sel.response);
  console.log('[probe] SELECT headers (raw):');
  console.log(sel.headers);

  // --- Step 4: cleanup CLEAR ---
  const clr = await timedSparql('CLEAR GRAPH (cleanup)', db, SPARQL_CLEAR);
  timings.clear_cleanup = { ms: clr.ms, ok: clr.ok };

  // --- Summary ---
  console.log('[probe] ---- SUMMARY ----');
  console.log(`[probe] access path:        CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)`);
  console.log(`[probe] CLEAR (initial):    ${timings.clear_initial.ms} ms`);
  console.log(`[probe] INSERT:             ${timings.insert.ms} ms`);
  console.log(`[probe] SELECT (2-hop):     ${timings.select.ms} ms`);
  console.log(`[probe] CLEAR (cleanup):    ${timings.clear_cleanup.ms} ms`);
  console.log('[probe] all operations succeeded.');
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    // Drain the cds connection before exiting so we don't get a noisy
    // "connection closed unexpectedly" stderr trail on Windows that buries
    // the privilege-error remediation message.
    try { await cds.shutdown?.(); } catch { /* swallow */ }

    if (err === PRIVILEGE_BLOCKER) {
      // exitCode already set to 2; remediation already printed.
      process.exit(process.exitCode || 2);
    }
    console.error('[probe] FATAL:', err && err.stack ? err.stack : err);
    process.exit(process.exitCode || 1);
  });
