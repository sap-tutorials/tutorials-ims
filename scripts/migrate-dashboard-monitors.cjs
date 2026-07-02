#!/usr/bin/env node
/**
 * scripts/migrate-dashboard-monitors.cjs
 *
 * #923 — Migrate IMS_DASHBOARD_MONITOR_RECORD from legacy Java IMS into
 * the CAP TutorialMonitors entity.
 *
 * Background: Java IMS's "My Tutorials" panel filters TutorialMeta by
 * rows joined to IMS_DASHBOARD_MONITOR_RECORD where user_id = current
 * user. It's a personal watch list — a user toggles it via a UI eye
 * icon (POST /tutorialMeta/setMonitoredStatus). Completely orthogonal
 * to TutorialMeta.owner (which is a maintainer signal). CAP never
 * migrated this table, which is why Sage's /author/MyOwnedTutorials
 * returned confusing rows after prior data fixes — it was reading the
 * WRONG table.
 *
 * What this script does
 *
 *   1. Reads IMS_DASHBOARD_MONITOR_RECORD JOIN IMS_TUTORIAL_META JOIN
 *      IMS_USER from live IMS. Each row becomes:
 *        - source_tutorial_legacy_id  (from IMS_TUTORIAL_META.tutorial_id)
 *        - source_user_sap_id         (from IMS_USER.SAP_ID)
 *   2. Resolves each pair against DEV:
 *        - Tutorials.legacyId = source_tutorial_legacy_id -> Tutorials.ID
 *        - Users.sapId       = source_user_sap_id        -> Users.ID
 *   3. Idempotent upsert: derive TutorialMonitors.ID via
 *      uuidv5(String(source_row_id), NAMESPACES.tutorialmonitor). Skip
 *      when the row already exists (unique constraint on user+tutorial).
 *   4. Orphan handling per Tom's decision (2026-07-02): if either
 *      resolution misses, SKIP and log to CSV. Do NOT create placeholder
 *      Users rows — safer than inventing identities.
 *
 * Fields not migrated
 *
 *   IMS_DASHBOARD_MONITOR_RECORD has only `id`, `tutorial_meta_id`,
 *   `user_id`. No timestamps, no createdBy. CAP's TutorialMonitors is
 *   `managed` so createdAt/createdBy get CURRENT_TIMESTAMP / the
 *   initiator label — a synthetic but honest audit signal.
 *
 * Flags
 *
 *   --dry-run          (default) preview + write CSV
 *   --commit           actually INSERT rows
 *   --verbose          per-row logging in dry-run
 *   --initiator <str>  audit label; default ${USER}@${hostname}
 *
 * Env
 *
 *   IMS_HANA_CREDENTIALS      JSON {host, port, user, password, schema}
 *                             OR IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD
 *   CAP_HANA_CREDENTIALS      JSON service-key for target CAP HDI
 *
 * Usage
 *
 *   IMS_HANA_CREDENTIALS=$(cat .migration-data/ims-creds.json) \
 *   CAP_HANA_CREDENTIALS=$(cat .migration-data/cap-dev-creds.json) \
 *   node scripts/migrate-dashboard-monitors.cjs --dry-run
 *
 *   ... within 60 minutes ...
 *
 *   ... same env ... \
 *   node scripts/migrate-dashboard-monitors.cjs --commit --initiator "scripts/migrate-dashboard-monitors@thomas.jung"
 *
 * Safety: --commit requires a fresh (<60 min) dry-run CSV.
 *
 * Idempotency: derives every TutorialMonitors.ID from the source
 * row's ID via uuidv5. Re-running is safe — collisions on the unique
 * (user, tutorial) constraint are treated as "already migrated" and
 * skipped without error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const hdb = require('hdb');
const { v5: uuidv5 } = require('uuid');
const NAMESPACES = require('./lib/migration-uuid-namespaces.cjs').NAMESPACES;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function argVal(f) { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; }

const DRY_RUN = has('--dry-run') || (!has('--commit'));
const COMMIT = has('--commit');
const VERBOSE = has('--verbose');
const INITIATOR =
  argVal('--initiator') ||
  process.env.INITIATOR ||
  `${process.env.USER || process.env.USERNAME || 'unknown'}@${os.hostname()}`;

const DRY_RUN_CSV = path.join(
  process.cwd(),
  '.migration-data',
  'migrate-dashboard-monitors.dryrun.csv'
);
const FRESH_DRY_RUN_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

function monitorRowUuid(sourceRowId) {
  return uuidv5(String(sourceRowId), NAMESPACES.tutorialmonitor);
}

/**
 * Given a source row and lookup maps, decide what to do. Pure function.
 *
 * @param {object} row  { SOURCE_ID, TUT_LEGACY_ID, USER_SAP_ID }
 * @param {Map<number|string,string>} tutorialByLegacyId
 *   legacyId -> Tutorials.ID (UUID)
 * @param {Map<string,string>} userBySapId
 *   sapId (lower) -> Users.ID (UUID)
 * @returns {{
 *   bucket: 'will-insert' | 'orphan-tutorial' | 'orphan-user',
 *   monitorUuid: string,
 *   tutorialId: string|null,
 *   userId: string|null,
 * }}
 */
function buildMigrateDecision(row, tutorialByLegacyId, userBySapId) {
  const monitorUuid = monitorRowUuid(row.SOURCE_ID);
  const tutorialId = tutorialByLegacyId.get(Number(row.TUT_LEGACY_ID))
    || tutorialByLegacyId.get(String(row.TUT_LEGACY_ID))
    || null;
  const sapKey = (row.USER_SAP_ID || '').trim().toLowerCase();
  const userId = sapKey ? (userBySapId.get(sapKey) || null) : null;

  if (!tutorialId) return { bucket: 'orphan-tutorial', monitorUuid, tutorialId: null, userId };
  if (!userId)     return { bucket: 'orphan-user',     monitorUuid, tutorialId, userId: null };
  return { bucket: 'will-insert', monitorUuid, tutorialId, userId };
}

// ---------------------------------------------------------------------------
// HANA client helpers (same shape as sibling scripts)
// ---------------------------------------------------------------------------

function connectHana(creds) {
  const port = parseInt(creds.port || '443', 10);
  const client = hdb.createClient({
    host: creds.host, port, user: creds.user, password: creds.password, useTLS: true
  });
  return new Promise((resolve, reject) => {
    client.connect((err) => (err ? reject(err) : resolve(client)));
  });
}
function runSql(client, sql) {
  return new Promise((resolve, reject) => {
    client.exec(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function prepareStmt(client, sql) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => (err ? reject(err) : resolve(stmt)));
  });
}
function runStmt(stmt, params) {
  return new Promise((resolve, reject) => {
    stmt.exec(params, (err, affected) => (err ? reject(err) : resolve(affected)));
  });
}

function resolveSourceCreds() {
  if (process.env.IMS_HANA_CREDENTIALS) return JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  if (process.env.IMS_DB_URL) {
    const url = new URL(process.env.IMS_DB_URL.replace('jdbc:sap://', 'https://'));
    return {
      host: url.hostname,
      port: url.port || '443',
      user: process.env.IMS_DB_USERNAME,
      password: process.env.IMS_DB_PASSWORD,
      schema: url.searchParams.get('currentschema') || process.env.IMS_DB_USERNAME,
    };
  }
  throw new Error('No source credentials. Set IMS_HANA_CREDENTIALS or IMS_DB_URL+IMS_DB_USERNAME+IMS_DB_PASSWORD.');
}
function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  throw new Error('No target credentials. Set CAP_HANA_CREDENTIALS to the JSON service-key.');
}

// ---------------------------------------------------------------------------
// CSV emission
// ---------------------------------------------------------------------------

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeDryRunCsv(decisions) {
  fs.mkdirSync(path.dirname(DRY_RUN_CSV), { recursive: true });
  const lines = [
    ['bucket', 'source_row_id', 'tut_legacy_id', 'user_sap_id',
     'target_tutorial_uuid', 'target_user_uuid', 'monitor_row_uuid'].join(','),
  ];
  for (const d of decisions) {
    lines.push([
      d.bucket,
      d.row.SOURCE_ID,
      d.row.TUT_LEGACY_ID,
      csvEscape(d.row.USER_SAP_ID),
      csvEscape(d.decision.tutorialId),
      csvEscape(d.decision.userId),
      d.decision.monitorUuid,
    ].join(','));
  }
  fs.writeFileSync(DRY_RUN_CSV, lines.join('\n') + '\n');
  return DRY_RUN_CSV;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (COMMIT) {
    if (!fs.existsSync(DRY_RUN_CSV)) {
      console.error(`--commit refused: no dry-run CSV at ${DRY_RUN_CSV}. Run --dry-run first.`);
      process.exit(2);
    }
    const ageMs = Date.now() - fs.statSync(DRY_RUN_CSV).mtimeMs;
    if (ageMs > FRESH_DRY_RUN_MS) {
      console.error(
        `--commit refused: dry-run CSV is ${Math.round(ageMs / 60000)}m old ` +
        `(threshold ${FRESH_DRY_RUN_MS / 60000}m). Re-run --dry-run first.`
      );
      process.exit(2);
    }
  }

  const sourceCreds = resolveSourceCreds();
  const targetCreds = resolveTargetCreds();

  console.log(`Source: ${(sourceCreds.host || '').slice(0, 30)}... user=${sourceCreds.user}`);
  console.log(`Target: ${(targetCreds.host || '').slice(0, 30)}... schema=${targetCreds.schema}`);
  console.log(DRY_RUN ? '=== DRY RUN — no INSERTs will be issued ===' : `=== COMMIT (initiator=${INITIATOR}) ===`);

  const source = await connectHana(sourceCreds);
  await runSql(source, `SET SCHEMA "${sourceCreds.schema}"`);
  console.log('  ✓ Connected to source IMS');

  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);
  console.log('  ✓ Connected to target CAP HANA');

  // Pull IMS monitor rows. Join through IMS_TUTORIAL_META (for the legacy
  // tutorial ID we can map to CAP Tutorials.legacyId) and IMS_USER (for
  // the SAP_ID we can map to CAP Users.sapId).
  const imsRows = await runSql(source, `
    SELECT
      DMR.ID                     AS SOURCE_ID,
      TM.TUTORIAL_ID             AS TUT_LEGACY_ID,
      IU.SAP_ID                  AS USER_SAP_ID
    FROM IMS_DASHBOARD_MONITOR_RECORD DMR
    JOIN IMS_TUTORIAL_META TM  ON TM.ID = DMR.TUTORIAL_META_ID
    JOIN IMS_USER          IU  ON IU.ID = DMR.USER_ID
  `);
  console.log(`  Read ${imsRows.length} monitor rows from live IMS`);

  // Load lookup maps from DEV.
  const tutorialRows = await runSql(target,
    `SELECT ID, LEGACYID FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE LEGACYID IS NOT NULL`);
  const tutorialByLegacyId = new Map();
  for (const r of tutorialRows) {
    tutorialByLegacyId.set(Number(r.LEGACYID), r.ID);
    tutorialByLegacyId.set(String(r.LEGACYID), r.ID);
  }
  console.log(`  Loaded ${tutorialRows.length} DEV Tutorials.legacyId -> ID entries`);

  const userRows = await runSql(target,
    `SELECT ID, SAPID FROM COM_SAP_DEVELOPERS_IMS_USERS WHERE SAPID IS NOT NULL AND LENGTH(TRIM(SAPID)) > 0`);
  const userBySapId = new Map();
  for (const r of userRows) {
    const key = String(r.SAPID || '').trim().toLowerCase();
    if (key && !userBySapId.has(key)) userBySapId.set(key, r.ID);
  }
  console.log(`  Loaded ${userRows.length} DEV Users.sapId -> ID entries`);

  // Build decisions.
  const decisions = [];
  const buckets = { 'will-insert': 0, 'orphan-tutorial': 0, 'orphan-user': 0 };
  for (const row of imsRows) {
    const decision = buildMigrateDecision(row, tutorialByLegacyId, userBySapId);
    decisions.push({ row, decision, bucket: decision.bucket });
    buckets[decision.bucket]++;
    if (VERBOSE) {
      console.log(
        `  [${decision.bucket}] source_id=${row.SOURCE_ID} tut_legacy=${row.TUT_LEGACY_ID} ` +
        `sap_id=${row.USER_SAP_ID} -> tut=${decision.tutorialId || '-'} user=${decision.userId || '-'}`
      );
    }
  }

  const csvPath = writeDryRunCsv(decisions);
  console.log(`  ✓ Dry-run CSV: ${csvPath}`);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Migrate DashboardMonitorRecord summary               ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Will insert:     ${buckets['will-insert']}`);
  console.log(`  Orphan tutorial: ${buckets['orphan-tutorial']}  (no DEV Tutorials.legacyId match)`);
  console.log(`  Orphan user:     ${buckets['orphan-user']}  (no DEV Users.sapId match)`);

  if (DRY_RUN) {
    console.log(
      `\n  Dry-run only. Review ${csvPath}, then re-run within ` +
      `${FRESH_DRY_RUN_MS / 60000} minutes with --commit.`
    );
    source.end();
    target.end();
    process.exit(0);
  }

  const inserts = decisions.filter((d) => d.bucket === 'will-insert');
  if (inserts.length === 0) {
    console.log('  Nothing to insert. Exiting.');
    source.end();
    target.end();
    process.exit(0);
  }

  // INSERT with WHERE NOT EXISTS guard. HANA doesn't ship ON CONFLICT
  // in vanilla SQL. The unique constraint on (USER_ID, TUTORIAL_ID) is
  // the safety net if a race slips through.
  const stmt = await prepareStmt(target, `
    INSERT INTO COM_SAP_DEVELOPERS_IMS_TUTORIALMONITORS
      (ID, USER_ID, TUTORIAL_ID, CREATEDAT, CREATEDBY, MODIFIEDAT, MODIFIEDBY)
    SELECT ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?
      FROM DUMMY
     WHERE NOT EXISTS (
       SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_TUTORIALMONITORS
        WHERE USER_ID = ? AND TUTORIAL_ID = ?
     )`);

  let inserted = 0, alreadyPresent = 0, errCount = 0;
  for (const d of inserts) {
    try {
      const affected = await runStmt(stmt, [
        d.decision.monitorUuid,
        d.decision.userId,
        d.decision.tutorialId,
        INITIATOR,
        INITIATOR,
        d.decision.userId,
        d.decision.tutorialId,
      ]);
      if (affected > 0) inserted++;
      else alreadyPresent++;
    } catch (e) {
      errCount++;
      if (errCount <= 5) {
        console.error(`  ✗ source_id=${d.row.SOURCE_ID}: ${(e.message || '').split('\n')[0]}`);
      }
    }
  }
  stmt.drop();

  console.log(`\n  Inserted: ${inserted}; already present: ${alreadyPresent}; errors: ${errCount}`);

  source.end();
  target.end();
  process.exit(errCount > 0 ? 1 : 0);
}

module.exports = { buildMigrateDecision, monitorRowUuid };

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exit(2);
  });
}
