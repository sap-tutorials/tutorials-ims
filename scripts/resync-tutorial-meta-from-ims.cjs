#!/usr/bin/env node
/**
 * scripts/resync-tutorial-meta-from-ims.cjs
 *
 * #862 (reopen 2026-07-02) — DEV / prod cutover data-hygiene helper.
 *
 * PR #920 fixed the publish path so that TutorialMeta.ownerEmail is
 * populated exclusively from the tutorial's declared author signal
 * (frontmatter author_profile -> Users.githubLogin -> Users.email),
 * never from a random `contributors[0].email`. That prevents *new*
 * contamination. But DEV's existing TutorialMeta rows still contain the
 * result of the Jan-2025 IMS backfill (scripts/backfill-tutorial-meta-
 * from-ims.cjs). Ownership in legacy prod IMS has been reshuffled since
 * then — Riley reported that MyOwnedTutorials returned 5 HXE tutorials
 * he no longer owns, while the one tutorial he DOES own today
 * ("Get to Know SAP Tutorials", legacyId 15733) was missing entirely.
 *
 * This script is a full-mirror resync: it re-reads TutorialMeta.OWNER
 * (via IMS_TUTORIAL_META joined to IMS_TUTORIAL_AUTHOR.EMAIL) from live
 * prod IMS today, and OVERWRITES the DEV values row-by-row. NOT a
 * COALESCE-only fill like scripts/backfill-tutorial-meta-from-ims.cjs
 * — that's the whole point. If IMS now says the OWNER of tutorial X
 * is different from what DEV has, DEV wins nothing; IMS is the ground
 * truth. That's what "full mirror" means.
 *
 * Design decisions (per Tom, 2026-07-02):
 *   1. Full mirror. Live IMS is ground truth. No admin-correction
 *      preservation heuristic. If an admin edited a row via the admin
 *      UI post-migration, that value will be overwritten. Trade-off
 *      accepted — admins can re-set post-resync if they still want
 *      the correction.
 *   2. Skip tutorials the live IMS has NO OPINION on. Tutorials
 *      published to DEV *after* Jan-2025 don't have a corresponding
 *      IMS row; we don't invent NULLs for them. The now-fixed publish
 *      path is authoritative for those.
 *   3. Ship as one commit. No admin-review-CSV gate.
 *   4. Fields touched: OWNER, OWNEREMAIL (both set to the same IMS
 *      value, matching the pattern the publish path uses). Not
 *      touching REVIEWEDDATE / NOTIFICATION_* / REPOSITORY_ID — those
 *      have different provenance and would need separate reasoning
 *      about whether IMS is authoritative today.
 *
 * Flags:
 *   --dry-run          (default) preview + write CSV to .migration-data/
 *   --commit           apply UPDATEs
 *   --verbose          per-row diff logging in dry-run
 *   --initiator <str>  audit label written to MODIFIEDBY. Defaults to
 *                      ${USER}@${hostname}. Overridden by INITIATOR env var.
 *
 * Env (source credentials — one of):
 *   IMS_HANA_CREDENTIALS      JSON {host, port, user, password, schema}
 *   IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD
 *
 * Env (target credentials — DEV CAP HANA):
 *   CAP_HANA_CREDENTIALS      JSON service-key (host, port, user, password, schema)
 *
 * Usage (dry-run):
 *   IMS_HANA_CREDENTIALS=$(cat .migration-data/ims-creds.json) \
 *   CAP_HANA_CREDENTIALS=$(cat .migration-data/cap-dev-creds.json) \
 *   node scripts/resync-tutorial-meta-from-ims.cjs --dry-run
 *
 * Usage (commit):
 *   ... same env ... \
 *   node scripts/resync-tutorial-meta-from-ims.cjs --commit \
 *     --initiator "scripts/resync-tutorial-meta-from-ims@thomas.jung"
 *
 * Safety: --commit requires a fresh (< 60 min) dry-run CSV to exist.
 * That CSV is the audit trail — attach it to the incident/PR when you
 * actually run this against DEV.
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
function argVal(f) {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
}

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
  'resync-tutorial-meta-from-ims.dryrun.csv'
);

const FRESH_DRY_RUN_MS = 60 * 60 * 1000; // 60 minutes

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

function tutorialUuid(legacyId) {
  return uuidv5(String(legacyId), NAMESPACES.tutorial);
}

/**
 * Given a source IMS row and the current DEV TutorialMeta row (or null if
 * DEV has no matching row yet), decide what to do. Pure function.
 *
 * Full-mirror semantics:
 *   - Placeholder IMS emails (bots, noreply) are treated as no-signal.
 *     Resync writes NULL for those. This matches the way the publish path
 *     never writes such addresses in the first place.
 *   - If DEV has no matching row for this tutorial UUID: skip (bucket
 *     `no-target-row`) — a resync is NOT a create.
 *   - If DEV row's current owner/ownerEmail already agrees with the
 *     desired IMS value: skip (bucket `already-matches`).
 *   - Otherwise emit an update (bucket `will-overwrite`) with the exact
 *     new owner/ownerEmail values.
 *
 * @param {object} imsRow  {TUT_LEGACY_ID, OWNER_EMAIL}
 * @param {object|null} devRow  {ID, TUTORIAL_ID, OWNER, OWNEREMAIL} — or null
 * @returns {{
 *   bucket: 'no-target-row'|'already-matches'|'will-overwrite',
 *   targetTutorialUuid: string,
 *   currentOwner: string|null,
 *   currentOwnerEmail: string|null,
 *   newOwner: string|null,
 *   newOwnerEmail: string|null
 * }}
 */
function buildResyncDecision(imsRow, devRow) {
  const targetTutorialUuid = tutorialUuid(imsRow.TUT_LEGACY_ID);

  // Placeholder emails are treated as "IMS has no clean signal here"
  // — same filter the original backfill uses.
  const isPlaceholder =
    imsRow.OWNER_EMAIL &&
    /(@users\.noreply\.github\.com|@sap-tutorials\.local)$/i.test(imsRow.OWNER_EMAIL);
  const newOwnerEmail =
    imsRow.OWNER_EMAIL && !isPlaceholder ? imsRow.OWNER_EMAIL : null;
  const newOwner = newOwnerEmail; // Mirror the publish-path invariant (owner == ownerEmail)

  if (!devRow) {
    return {
      bucket: 'no-target-row',
      targetTutorialUuid,
      currentOwner: null,
      currentOwnerEmail: null,
      newOwner,
      newOwnerEmail,
    };
  }

  const currentOwner = devRow.OWNER ?? null;
  const currentOwnerEmail = devRow.OWNEREMAIL ?? null;

  const bothNull =
    newOwner == null && newOwnerEmail == null &&
    currentOwner == null && currentOwnerEmail == null;

  if (bothNull) {
    return {
      bucket: 'already-matches',
      targetTutorialUuid,
      currentOwner,
      currentOwnerEmail,
      newOwner,
      newOwnerEmail,
    };
  }

  const emailAgrees =
    (currentOwnerEmail || '').toLowerCase() === (newOwnerEmail || '').toLowerCase();
  const ownerAgrees =
    (currentOwner || '').toLowerCase() === (newOwner || '').toLowerCase();

  if (emailAgrees && ownerAgrees) {
    return {
      bucket: 'already-matches',
      targetTutorialUuid,
      currentOwner,
      currentOwnerEmail,
      newOwner,
      newOwnerEmail,
    };
  }

  return {
    bucket: 'will-overwrite',
    targetTutorialUuid,
    currentOwner,
    currentOwnerEmail,
    newOwner,
    newOwnerEmail,
  };
}

// ---------------------------------------------------------------------------
// HANA client helpers (mirror scripts/backfill-tutorial-meta-from-ims.cjs)
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
  if (process.env.IMS_HANA_CREDENTIALS) {
    return JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  }
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
  throw new Error(
    'No source credentials. Set IMS_HANA_CREDENTIALS or IMS_DB_URL+IMS_DB_USERNAME+IMS_DB_PASSWORD.'
  );
}

function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) {
    return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  }
  throw new Error(
    'No target credentials. Set CAP_HANA_CREDENTIALS to the JSON service-key.'
  );
}

// ---------------------------------------------------------------------------
// CSV emission — one row per decision (buckets included).
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
    ['bucket', 'tut_legacy_id', 'target_tutorial_uuid',
     'current_owner', 'current_ownerEmail',
     'new_owner', 'new_ownerEmail'].join(','),
  ];
  for (const d of decisions) {
    lines.push([
      d.bucket,
      d.imsRow.TUT_LEGACY_ID,
      d.decision.targetTutorialUuid,
      csvEscape(d.decision.currentOwner),
      csvEscape(d.decision.currentOwnerEmail),
      csvEscape(d.decision.newOwner),
      csvEscape(d.decision.newOwnerEmail),
    ].join(','));
  }
  fs.writeFileSync(DRY_RUN_CSV, lines.join('\n') + '\n');
  return DRY_RUN_CSV;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Enforce dry-run-first discipline: --commit requires a fresh CSV to exist.
  if (COMMIT) {
    if (!fs.existsSync(DRY_RUN_CSV)) {
      console.error(
        `--commit refused: no dry-run CSV at ${DRY_RUN_CSV}. Run --dry-run first.`
      );
      process.exit(2);
    }
    const st = fs.statSync(DRY_RUN_CSV);
    const ageMs = Date.now() - st.mtimeMs;
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
  console.log(DRY_RUN ? '=== DRY RUN — no UPDATEs will be issued ===' : `=== COMMIT (initiator=${INITIATOR}) ===`);

  const source = await connectHana(sourceCreds);
  await runSql(source, `SET SCHEMA "${sourceCreds.schema}"`);
  console.log('  ✓ Connected to source IMS');

  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);
  console.log('  ✓ Connected to target CAP HANA');

  // Pull IMS rows. Same join the original backfill uses. EMAIL may be null.
  const imsRows = await runSql(source, `
    SELECT
      TM.TUTORIAL_ID  AS TUT_LEGACY_ID,
      A.EMAIL         AS OWNER_EMAIL
    FROM IMS_TUTORIAL_META TM
    JOIN IMS_TUTORIAL_AUTHOR A ON TM.OWNER_ID = A.ID
  `);
  console.log(`  Read ${imsRows.length} TutorialMeta rows from live IMS`);

  // Pull all current DEV TutorialMeta rows. Preloading is cheaper than N
  // point-selects (~1400 rows fits comfortably in one round-trip).
  const devRows = await runSql(target,
    `SELECT ID, TUTORIAL_ID, OWNER, OWNEREMAIL FROM COM_SAP_DEVELOPERS_IMS_TUTORIALMETA`);
  console.log(`  Read ${devRows.length} TutorialMeta rows from DEV`);

  const devByTutorialUuid = new Map();
  for (const r of devRows) devByTutorialUuid.set(r.TUTORIAL_ID, r);

  // Build decisions.
  const decisions = [];
  for (const imsRow of imsRows) {
    const targetUuid = tutorialUuid(imsRow.TUT_LEGACY_ID);
    const devRow = devByTutorialUuid.get(targetUuid) || null;
    const decision = buildResyncDecision(imsRow, devRow);
    decisions.push({ imsRow, decision, bucket: decision.bucket });
  }

  // Bucket counts for the summary.
  const buckets = { 'will-overwrite': 0, 'already-matches': 0, 'no-target-row': 0 };
  for (const d of decisions) buckets[d.bucket]++;

  const csvPath = writeDryRunCsv(decisions);
  console.log(`  ✓ Dry-run CSV: ${csvPath}`);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Resync summary                                       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Will overwrite:        ${buckets['will-overwrite']}`);
  console.log(`  Already matches:       ${buckets['already-matches']}`);
  console.log(`  No target row (skip):  ${buckets['no-target-row']}`);

  if (VERBOSE) {
    for (const d of decisions.slice(0, 50)) {
      console.log(
        `  [${d.bucket}] tut=${d.imsRow.TUT_LEGACY_ID} ` +
        `owner: ${d.decision.currentOwnerEmail || '-'} → ${d.decision.newOwnerEmail || '-'}`
      );
    }
    if (decisions.length > 50) {
      console.log(`  ... (${decisions.length - 50} more; see CSV for full list)`);
    }
  }

  if (DRY_RUN) {
    console.log(
      `\n  Dry-run only. Review ${csvPath}, then re-run within ` +
      `${FRESH_DRY_RUN_MS / 60000} minutes with --commit.`
    );
    source.end();
    target.end();
    process.exit(0);
  }

  // COMMIT path.
  const overwrites = decisions.filter(d => d.bucket === 'will-overwrite');
  if (overwrites.length === 0) {
    console.log('  Nothing to overwrite. Exiting.');
    source.end();
    target.end();
    process.exit(0);
  }

  const stmt = await prepareStmt(target,
    `UPDATE COM_SAP_DEVELOPERS_IMS_TUTORIALMETA
        SET OWNER      = ?,
            OWNEREMAIL = ?,
            MODIFIEDAT = CURRENT_TIMESTAMP,
            MODIFIEDBY = ?
      WHERE TUTORIAL_ID = ?`);

  let ok = 0, err = 0;
  for (const d of overwrites) {
    try {
      const affected = await runStmt(stmt, [
        d.decision.newOwner,
        d.decision.newOwnerEmail,
        INITIATOR,
        d.decision.targetTutorialUuid,
      ]);
      if (affected > 0) ok++;
      else err++;
    } catch (e) {
      err++;
      if (err <= 5) {
        console.error(
          `  ✗ tut=${d.imsRow.TUT_LEGACY_ID}: ${(e.message || '').split('\n')[0]}`
        );
      }
    }
  }
  stmt.drop();

  console.log(`\n  Committed: ${ok} overwrites; errors: ${err}`);

  source.end();
  target.end();
  process.exit(err > 0 ? 1 : 0);
}

module.exports = { buildResyncDecision, tutorialUuid };

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exit(2);
  });
}
