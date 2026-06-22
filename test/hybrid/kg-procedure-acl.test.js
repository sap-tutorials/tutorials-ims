// test/hybrid/kg-procedure-acl.test.js
//
// Regression test for the DEFINER-rights claim that motivates the procedure layer.
//
// CLAIM BEING PROVEN
//   Two distinct HDI binding-runtime-users can both write to the same named graph
//   because the procedure body runs as the stable object-owner identity (#OO), NOT
//   as the calling user. If the body ran with invoker rights instead, the SECOND
//   binding's INSERT would fail "User is not allowed to perform this action - (INSERT)"
//   — exactly the bug documented in issue #533.
//
// HOW IT WORKS
//   1. Read existing service-key credentials (Binding-A).
//   2. Create an ephemeral second service-key (Binding-B) — different runtime user.
//   3. Connect both via raw `hdb` (NOT cds.connect.to — we need per-user connections).
//   4. Self-check: confirm CURRENT_USER differs between the two connections.
//   5. Binding-A calls KG_GRAPH_INSERT — succeeds (creates graph, #OO becomes ACL owner).
//   6. Binding-B calls KG_GRAPH_INSERT on THE SAME graph — must succeed.
//      With invoker rights this fails: "User is not allowed to perform this action".
//   7. Binding-B calls KG_GRAPH_CLEAR on the same graph — must succeed.
//   8. afterAll: best-effort cleanup via Binding-A CLEAR.
//
// SKIP BEHAVIOUR
//   The test skips gracefully (not fails) when:
//   - `cf service-key` returns nothing (CF not logged in)
//   - `cf create-service-key` fails (insufficient CF permissions)
//   Skipping is announced via console.warn so the CI log shows the reason.
//   The test fails LOUDLY only when canRun=true AND a procedure call fails.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/kg-procedure-acl.test.js
//
// ISSUE: #533
// SPEC:   docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import hdb from 'hdb';
import { setTimeout as sleep } from 'node:timers/promises';

// --- run-scoped constants ---

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// IRI must match KG_GRAPH_INSERT validator: ^urn:[A-Za-z0-9:_-]+$
const TEST_GRAPH = `urn:test:acl-proof:${RUN_ID}`;
const SECOND_KEY = `kg-acl-proof-${RUN_ID}`;

// --- test state ---

let canRun = false;
let skipReason = null;
let clientA = null;
let clientB = null;
let credA = null;
let credB = null;

// --- helpers ---

/**
 * Parse `cf service-key` stdout: strips the human-readable header lines and
 * returns the parsed JSON object wrapping the credentials.
 * Output format:
 *   Getting key <name> for service instance <inst> as <user>...
 *
 *   { "credentials": { ... } }
 */
function parseKey(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

/**
 * Fetch a service-key with retry.  Some HDI service keys are provisioned
 * asynchronously — `cf service-key` immediately after `cf create-service-key`
 * may return "Creation of service key in progress" and exit non-zero.
 * We poll up to maxAttempts times with a 5-second delay between attempts.
 */
async function fetchServiceKeyWithRetry(instance, keyName, maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = execFileSync(
        'cf',
        ['service-key', instance, keyName],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      // If the key is still provisioning, stdout contains "in progress" and
      // no '{' is found (or the JSON has no credentials).
      const idx = out.indexOf('{');
      if (idx === -1) throw new Error(`No JSON in output: ${out.slice(0, 200)}`);
      const parsed = JSON.parse(out.slice(idx));
      if (!parsed.credentials) throw new Error(`No credentials in output`);
      return parsed;
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      // eslint-disable-next-line no-console
      console.warn(`[kg-procedure-acl] service-key not ready (attempt ${attempt}/${maxAttempts}): ${e.message} — retrying in 5s`);
      await sleep(5_000);
    }
  }
}

/**
 * Open an hdb connection with TLS. Returns the connected client.
 * NOTE: raw hdb connections do NOT set CURRENT_SCHEMA automatically.
 * Callers must issue SET SCHEMA after connect.
 */
function connectHdb(c) {
  return new Promise((resolve, reject) => {
    const client = hdb.createClient({
      host: c.host,
      port: parseInt(c.port, 10),
      user: c.user,
      password: c.password,
      useTLS: true,
      encrypt: true,
      sslValidateCertificate: false,
    });
    client.connect((err) => (err ? reject(err) : resolve(client)));
  });
}

/**
 * Execute a parameterised statement via client.prepare + stmt.exec.
 * Returns the result rows array (injection-safe).
 */
function runStmt(client, sql, params = []) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => {
      if (err) return reject(err);
      stmt.exec(params, (err2, rows) => (err2 ? reject(err2) : resolve(rows)));
    });
  });
}

// --- DO-block wrappers ---
// Raw hdb shares the same OUT-param limitation as @cap-js/hana.
// Wrapping in a DO block converts OUT params to a SELECT result-set.
// Schema is set via SET SCHEMA so procedure names are unqualified.

const DO_CALL_KG_GRAPH_INSERT = [
  'DO (IN p NVARCHAR(500) => ?, IN t NCLOB => ?) BEGIN',
  '  DECLARE response NCLOB;',
  '  DECLARE headers NVARCHAR(5000);',
  '  CALL KG_GRAPH_INSERT(:p, :t, response, headers);',
  '  SELECT :response AS response, :headers AS headers FROM DUMMY;',
  'END',
].join('\n');

async function callKgGraphInsert(client, graphIri, triples) {
  return runStmt(client, DO_CALL_KG_GRAPH_INSERT, [graphIri, triples]);
}

const DO_CALL_KG_GRAPH_CLEAR = [
  'DO (IN p NVARCHAR(500) => ?) BEGIN',
  '  DECLARE response NCLOB;',
  '  DECLARE headers NVARCHAR(5000);',
  '  CALL KG_GRAPH_CLEAR(:p, response, headers);',
  '  SELECT :response AS response, :headers AS headers FROM DUMMY;',
  'END',
].join('\n');

async function callKgGraphClear(client, graphIri) {
  return runStmt(client, DO_CALL_KG_GRAPH_CLEAR, [graphIri]);
}

// --- test suite ---

describe('Cross-binding ACL proof — DEFINER procedures (issue #533)', () => {
  beforeAll(async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';

    // 1. Fetch Binding-A credentials from the existing service key.
    try {
      const outA = execFileSync(
        'cf',
        ['service-key', 'tutorials-hana', 'tutorials-hana-key'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      credA = parseKey(outA).credentials;
    } catch (e) {
      skipReason = `Cannot fetch tutorials-hana-key: ${e.message}`;
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }

    // 2. Create an ephemeral second service key for Binding-B.
    try {
      execFileSync(
        'cf',
        ['create-service-key', 'tutorials-hana', SECOND_KEY],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      skipReason = `Cannot create second service-key (CF permission or quota?): ${e.message}`;
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }

    // 3. Fetch Binding-B credentials — retry because HDI service-key provisioning
    //    is asynchronous; the key may not be ready immediately after create.
    try {
      const parsed = await fetchServiceKeyWithRetry('tutorials-hana', SECOND_KEY);
      credB = parsed.credentials;
    } catch (e) {
      skipReason = `Cannot fetch second key credentials after retries: ${e.message}`;
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }

    // 4. Open both hdb connections.
    try {
      clientA = await connectHdb(credA);
      clientB = await connectHdb(credB);
    } catch (e) {
      skipReason = `Cannot open hdb connection: ${e.message}`;
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }

    // 5. Set schema on both connections so unqualified procedure names resolve.
    //    credA.schema and credB.schema are the same HDI deploy schema.
    //    Double-quote guards against UPPERCASE identifiers (memory: hana_raw_sql_uppercase).
    await runStmt(clientA, `SET SCHEMA "${credA.schema}"`);
    await runStmt(clientB, `SET SCHEMA "${credB.schema}"`);

    canRun = true;
  }, 120_000); // service-key create + async provisioning + 8×5s retries; allow 120s total

  afterAll(async () => {
    // Best-effort cleanup — do not throw, cleanup failures are non-fatal.

    // Clear test graph via Binding-A (graph may not exist if INSERT tests failed).
    if (clientA) {
      try {
        await callKgGraphClear(clientA, TEST_GRAPH);
      } catch {
        // ignore
      }
    }

    // Disconnect both clients.
    try { if (clientA) clientA.disconnect(); } catch { /* ignore */ }
    try { if (clientB) clientB.disconnect(); } catch { /* ignore */ }

    // Delete the ephemeral service key unconditionally so orphaned keys don't accumulate.
    try {
      execFileSync(
        'cf',
        ['delete-service-key', '-f', 'tutorials-hana', SECOND_KEY],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch {
      // Service key might not have been created (e.g. beforeAll bailed early).
    }
  }, 60_000); // delete-service-key can take 10-30s

  // -- self-check --

  it('Binding-A CURRENT_USER differs from Binding-B CURRENT_USER (self-check: test is only meaningful with two distinct users)', async () => {
    if (!canRun) {
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }
    const rowsA = await runStmt(clientA, 'SELECT CURRENT_USER FROM DUMMY');
    const rowsB = await runStmt(clientB, 'SELECT CURRENT_USER FROM DUMMY');
    const ua = rowsA[0]?.CURRENT_USER;
    const ub = rowsB[0]?.CURRENT_USER;
    console.log(`[kg-procedure-acl] Binding-A user: ${ua}`);
    console.log(`[kg-procedure-acl] Binding-B user: ${ub}`);
    // If both collapse to the same user, the test cannot prove the ACL claim.
    expect(ua).toBeDefined();
    expect(ub).toBeDefined();
    expect(ua).not.toBe(ub);
  });

  // -- DEFINER-mode proof --

  it('Binding-A can INSERT into the test graph (graph created as #OO via DEFINER)', async () => {
    if (!canRun) {
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }
    // KG_GRAPH_INSERT runs as #OO (DEFINER). The per-graph ACL records #OO as
    // the owner. Later writes from any binding succeed because they also run as #OO.
    await expect(
      callKgGraphInsert(clientA, TEST_GRAPH, '<urn:a> <urn:b> <urn:c> .')
    ).resolves.toBeDefined();
  });

  it('Binding-B can ALSO INSERT into the same graph — regression proof (fails with invoker rights)', async () => {
    if (!canRun) {
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }
    // CRITICAL: with invoker rights, Binding-B's runtime user is NOT the ACL owner
    // of TEST_GRAPH (Binding-A created it). HANA would reject with:
    //   "User is not allowed to perform this action - (INSERT)"
    // With DEFINER rights, both bindings run as the same #OO identity, so this
    // INSERT succeeds regardless of which binding calls it.
    // A failure here means SQL_SECURITY = DEFINER is NOT taking effect.
    await expect(
      callKgGraphInsert(clientB, TEST_GRAPH, '<urn:d> <urn:e> <urn:f> .')
    ).resolves.toBeDefined();
  });

  it('Binding-B can CLEAR the same graph (would fail with invoker rights)', async () => {
    if (!canRun) {
      console.warn(`[kg-procedure-acl] SKIP: ${skipReason}`);
      return;
    }
    // Same reasoning as INSERT above: with invoker rights Binding-B is not the
    // ACL owner of TEST_GRAPH so CLEAR would fail.
    await expect(callKgGraphClear(clientB, TEST_GRAPH)).resolves.toBeDefined();
  });
});
