/* eslint-disable no-console */
/**
 * backfill-user-profiles.cjs — One-shot backfill for Users.email/firstName/lastName/displayName
 * from SCI / SAP ID Service (legacy IMS Java pattern).
 *
 * Issue: https://github.com/sap-tutorials/tutorials-ims/issues/632
 *
 * Why: ~789k Users rows from the IMS migration have NULL email/firstName/lastName.
 *      The CAP runtime self-heals one row at a time on user login, but bulk
 *      reporting (admin search-by-email, advocate value-help, #620 tutorial-author
 *      backfill) needs the columns populated up-front.
 *
 * Source: GET /cps/user/{sapId}.json on destination SCI_prod (accounts.sap.com).
 *         Same endpoint IMS Java's SciClientImpl used. Returns
 *         { user: { mail, firstName, lastName, displayName, ... } }.
 *         No photo URL is present — Users.avatarUrl is left alone.
 *
 * Strategy:
 *   - Read Users where email IS NULL AND sapId IS NOT NULL, in pages of 1000.
 *   - Resolve via SCI with concurrency limit (default 5).
 *   - 404 → log + skip (ex-employees, common case).
 *   - 4xx/5xx → retry once with 1s backoff, then mark failed.
 *   - UPDATE gated by `email IS NULL` so re-runs only touch unmatched rows.
 *   - Write a report under .migration-data/ for audit + resume diagnostics.
 *
 * Modes:
 *   default      — DRY RUN. Resolves and counts; zero writes.
 *   --dry-run    — explicit alias for default.
 *   --commit     — execute UPDATEs.
 *   --limit=N    — stop after N rows processed (handy for smoke runs).
 *   --offset=N   — skip first N rows (resume).
 *   --concurrency=N (default 5)
 *   --batch-size=N (default 1000 — rows fetched from DB per page)
 *   --throttle-ms=N (default 0 — min spacing in ms between SCI calls; SEE NOTE BELOW)
 *   --quiet      — suppress per-row progress; only milestones.
 *
 * RATE LIMITING — important:
 *   Observed during dev (2026-06-25): SCI's `/cps/user/{sapId}.json` returns
 *   200 at first, then flips to 403 across ALL sapIds (including the same one
 *   that just worked) once a per-account threshold is hit. The block appears
 *   to be temporary. If a smoke run sees 100% 403s, wait an hour and retry
 *   with `--throttle-ms=1000` or higher. The legacy IMS Java app runs at
 *   trickle-rate (one CPS call per user login) and doesn't trip this. The
 *   long-term answer is to coordinate with the SCI / Customer Identity team
 *   for a rate-limit lift on this technical user.
 *
 * Usage:
 *   # dry-run smoke (no writes) — 20 users
 *   npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --limit=20
 *
 *   # live smoke
 *   npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --limit=20 --commit
 *
 *   # full backfill
 *   npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --commit
 *
 *   # resume after a crash at row 450,000
 *   npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --commit --offset=450000
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

// --- Arg parsing ---------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name, def) {
  const found = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!found) return def;
  if (!found.includes('=')) return true;
  return found.split('=')[1];
}
const COMMIT = argv.includes('--commit');
const DRY_RUN = !COMMIT;
const LIMIT = Number(arg('limit', 0)) || 0;          // 0 = no cap
const OFFSET = Number(arg('offset', 0)) || 0;
const CONCURRENCY = Number(arg('concurrency', 5));
const BATCH_SIZE = Number(arg('batch-size', 1000));
const THROTTLE_MS = Number(arg('throttle-ms', 0));   // min spacing between SCI calls (rate-limit knob)
const QUIET = !!arg('quiet', false);

// --- Table names ---------------------------------------------------------

const T_USERS = '"COM_SAP_DEVELOPERS_IMS_USERS"';

// --- Report scaffolding --------------------------------------------------

const REPORT_DIR = path.resolve(__dirname, '..', '.migration-data');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
const tsStamp = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_PATH = path.join(REPORT_DIR, `user-profile-backfill-${tsStamp}.json`);

const report = {
  ranAt: new Date().toISOString(),
  committed: COMMIT,
  args: { LIMIT, OFFSET, CONCURRENCY, BATCH_SIZE, THROTTLE_MS },
  summary: {
    candidates_total: 0,
    processed: 0,
    matched: 0,
    updated: 0,
    not_found_404: 0,
    failed_other: 0,
  },
  errors: [],   // { sapId, status, message }
  notFound: [], // first 50 only, for audit
};

// --- Destination resolution (cached) -------------------------------------

let cachedDest;
async function getSciDest() {
  if (cachedDest) return cachedDest;
  const { getDestination } = require('@sap-cloud-sdk/connectivity');
  const d = await getDestination({ destinationName: 'SCI_prod' });
  if (!d) throw new Error('SCI_prod destination not visible. Bind tutorials-destination and verify cockpit entry.');
  if (!d.password || d.password === '<removed>') {
    throw new Error('SCI_prod destination password is empty or redacted. Edit destination in BTP cockpit.');
  }
  cachedDest = {
    url: d.url,
    auth: 'Basic ' + Buffer.from(`${d.username}:${d.password}`).toString('base64'),
  };
  return cachedDest;
}

// --- SCI fetch with one retry --------------------------------------------

// Global pace gate. When THROTTLE_MS > 0, ensures no two SCI calls start
// closer together than that many ms (across concurrent workers). Used as a
// rate-limit knob — SCI rejects bulk traffic with 403 once a per-account
// threshold is hit (observed during #632 dev, 2026-06-25).
let lastCallAt = 0;
async function paceGate() {
  if (!THROTTLE_MS) return;
  const now = Date.now();
  const wait = Math.max(0, (lastCallAt + THROTTLE_MS) - now);
  lastCallAt = Math.max(now, lastCallAt) + THROTTLE_MS;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

async function fetchSciUser(sapId) {
  await paceGate();
  const { url, auth } = await getSciDest();
  const endpoint = `${url}/cps/user/${encodeURIComponent(sapId)}.json`;
  // up to 2 attempts: initial + 1 retry
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(endpoint, {
        headers: { 'Authorization': auth, 'Accept': 'application/json' },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (res.status === 200) {
        const json = await res.json();
        return { ok: true, user: json && json.user ? json.user : null };
      }
      if (res.status === 404) {
        return { ok: false, status: 404, message: 'not found' };
      }
      // retryable
      lastErr = { status: res.status, message: await res.text().then(t => t.slice(0, 200)).catch(() => '') };
    } catch (e) {
      lastErr = { status: 0, message: e.message };
    }
    if (attempt === 1) await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, ...lastErr };
}

// --- DB layer ------------------------------------------------------------

async function countCandidates(db) {
  const r = await db.run(
    `SELECT COUNT(*) AS C FROM ${T_USERS} WHERE EMAIL IS NULL AND SAPID IS NOT NULL`
  );
  return r[0]?.C || 0;
}

async function fetchPage(db, offset, size) {
  // Stable ordering for resumability. ID is the cuid PK — already indexed,
  // unique, monotonic-enough for paging. We can't use createdAt: it's NULL
  // for the migrated rows (PR #634 dropped that column from migration).
  return db.run(
    `SELECT ID, SAPID FROM ${T_USERS}
      WHERE EMAIL IS NULL AND SAPID IS NOT NULL
      ORDER BY ID
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`
  );
}

async function updateUser(db, id, fields) {
  // Idempotent gate: only UPDATE if email is still NULL. Belt-and-braces; a
  // concurrent self-heal at user login should not be overwritten.
  return db.run(
    `UPDATE ${T_USERS}
        SET EMAIL       = COALESCE(EMAIL,       ?),
            FIRSTNAME   = COALESCE(FIRSTNAME,   ?),
            LASTNAME    = COALESCE(LASTNAME,    ?),
            DISPLAYNAME = COALESCE(DISPLAYNAME, ?),
            MODIFIEDAT  = CURRENT_UTCTIMESTAMP
      WHERE ID = ? AND EMAIL IS NULL`,
    [fields.email || null, fields.firstName || null, fields.lastName || null, fields.displayName || null, id]
  );
}

// --- Concurrency primitive (p-limit shim) --------------------------------

function pLimit(n) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(v => { active--; drain(); resolve(v); }, e => { active--; drain(); reject(e); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); drain(); });
}

// --- Main loop -----------------------------------------------------------

(async () => {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);
  console.log(`Concurrency: ${CONCURRENCY}, batch size: ${BATCH_SIZE}, offset: ${OFFSET}, limit: ${LIMIT || 'none'}, throttle: ${THROTTLE_MS}ms`);

  // Validate destination up-front before doing any DB work.
  try {
    await getSciDest();
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(2);
  }

  const total = await countCandidates(db);
  report.summary.candidates_total = total;
  console.log(`Candidates (email IS NULL AND sapId IS NOT NULL): ${total}`);
  if (total === 0) {
    console.log('Nothing to backfill. Exiting.');
    writeReport();
    process.exit(0);
  }

  const limit = pLimit(CONCURRENCY);
  let offset = OFFSET;
  let processed = 0;
  const startedAt = Date.now();

  while (true) {
    const remainingLimit = LIMIT ? (LIMIT - processed) : Number.POSITIVE_INFINITY;
    if (remainingLimit <= 0) break;
    const pageSize = Math.min(BATCH_SIZE, remainingLimit);
    const page = await fetchPage(db, offset, pageSize);
    if (page.length === 0) break;

    const tasks = page.map(row => limit(async () => {
      const sapId = row.SAPID;
      const id = row.ID;
      const result = await fetchSciUser(sapId);
      if (!result.ok) {
        if (result.status === 404) {
          report.summary.not_found_404++;
          if (report.notFound.length < 50) report.notFound.push({ id, sapId });
          if (!QUIET) process.stdout.write('.');
          return;
        }
        report.summary.failed_other++;
        report.errors.push({ id, sapId, status: result.status, message: result.message });
        if (!QUIET) process.stdout.write('x');
        return;
      }
      const u = result.user;
      if (!u) {
        report.summary.failed_other++;
        report.errors.push({ id, sapId, status: 200, message: 'response had no `user` member' });
        return;
      }
      report.summary.matched++;
      const fields = {
        email: u.mail || null,
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        displayName: u.displayName || null,
      };
      if (COMMIT) {
        try {
          const r = await updateUser(db, id, fields);
          // HANA UPDATE returns rowsAffected as number or array — best-effort
          const ra = (typeof r === 'number') ? r : (Array.isArray(r) ? r[0] : (r?.affectedRows ?? 1));
          if (ra > 0) report.summary.updated++;
        } catch (e) {
          report.summary.failed_other++;
          report.errors.push({ id, sapId, status: -1, message: `UPDATE: ${e.message}` });
        }
      }
      if (!QUIET) process.stdout.write('+');
    }));
    await Promise.all(tasks);

    processed += page.length;
    offset += page.length;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = (processed / elapsed).toFixed(1);
    const remaining = (LIMIT ? Math.min(LIMIT, total) : total) - processed;
    const eta = rate > 0 ? Math.round(remaining / rate) : '?';
    process.stdout.write(`\n[${new Date().toISOString().slice(11,19)}] processed=${processed} matched=${report.summary.matched} updated=${report.summary.updated} notFound=${report.summary.not_found_404} failed=${report.summary.failed_other} rate=${rate}/s eta=${eta}s\n`);
  }

  report.summary.processed = processed;
  writeReport();
  console.log('\n=== Summary ===');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${REPORT_PATH}`);
  if (DRY_RUN) console.log('\nDRY RUN — no rows were written. Re-run with --commit to apply.');
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  report.errors.push({ id: null, sapId: null, status: -1, message: `FATAL: ${e.message}` });
  try { writeReport(); } catch {}
  process.exit(1);
});

function writeReport() {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}
