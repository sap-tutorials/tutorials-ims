#!/usr/bin/env node
/**
 * reconcile-tutorials-legacyid.cjs - backfill TUTORIALS.LEGACYID from IMS prod
 *
 * Filed as #257 Option B follow-up after the 2026-06-05 HDI data loss.
 *
 * Background
 * ----------
 * The NavigatorCatalog view (db/views.cds) joins:
 *
 *   CompletionPathItems (item) INNER JOIN Tutorials (tut)
 *     ON tut.legacyId = item.taskLegacyId
 *
 * After the 2026-06-05 wipe + recovery, DEV TUTORIALS.LEGACYID was populated
 * with synthetic values (20000, 20001, 20002...) that do not match real IMS
 * task IDs (which are 6-digit values like 149348). Result: the join produces
 * 0 rows and /build/catalog returns tutorialMappings: 0.
 *
 * Earlier hypothesis was that CPI.TUTORIAL_ID needed to be backfilled
 * (referenced in #257). Probing the actual NavigatorCatalog view at
 * db/views.cds:55 confirmed the join is on legacyId, not on tutorial_ID.
 *
 * The fix
 * -------
 * For each DEV TUTORIALS row with a slug, find the canonical IMS_TASK by
 * matching the slug against IMS_TASK.URL ending in /<slug>.md. Pick the
 * best candidate (canonical sap-tutorials org, non-DELETED, oldest ID
 * among ties). Update TUTORIALS.LEGACYID to the real IMS task ID.
 *
 * Note: TUTORIALS.LEGACYID is metadata only. Foreign-key references from
 * other tables (TutorialMeta, etc.) point at TUTORIALS.ID (UUID), not
 * legacyId. Updating legacyId is safe.
 *
 * Idempotent - safe to re-run. Skips rows whose LEGACYID already matches
 * the best IMS candidate.
 *
 * Usage
 * -----
 *   # Read-only dry-run (recommended first):
 *   node scripts/reconcile-tutorials-legacyid.cjs --dry-run
 *
 *   # Live (writes UPDATE statements):
 *   node scripts/reconcile-tutorials-legacyid.cjs
 *
 *   # Verbose (per-row resolution detail):
 *   node scripts/reconcile-tutorials-legacyid.cjs --dry-run --verbose
 *
 * Source (IMS) credentials: read from .migration-data/ims-creds.json
 * (gitignored). Same file used by migrate-from-hana.js.
 *
 * Target (DEV CAP HDI): resolved at runtime from
 * cf service-key tutorials-hana tutorials-hana-key.
 *
 * Exit codes:
 *   0 - completed successfully (whether dry-run or live)
 *   1 - runtime / connection error
 *   2 - partial reconciliation (some tutorials had no IMS match)
 */
'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const hdb = require('hdb');
const { deriveSlug, planUpdates } = require('./lib/cpi-reconcile-helpers.cjs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

// ─── credentials ──────────────────────────────────────────────────────────────
function getImsCreds() {
  const path = '.migration-data/ims-creds.json';
  if (!fs.existsSync(path)) {
    throw new Error(`IMS creds not found at ${path}. See docs/developers/operations/hdi-deploy-checklist.md.`);
  }
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

function getDevCreds() {
  // execFileSync - shell-free, injection-safe.
  const out = childProcess.execFileSync('cf', ['service-key', 'tutorials-hana', 'tutorials-hana-key'], { encoding: 'utf-8' });
  return JSON.parse(out.slice(out.indexOf('{'))).credentials;
}

function connect(c, label) {
  return new Promise((resolve, reject) => {
    const client = hdb.createClient({
      host: c.host, port: parseInt(c.port, 10),
      user: c.user, password: c.password,
      useTLS: true, encrypt: true, sslValidateCertificate: false,
    });
    client.connect(err => {
      if (err) reject(new Error(`HANA connect to ${label} failed: ${err.message}`));
      else resolve(client);
    });
  });
}

function runStmt(client, sql, params = []) {
  return new Promise((resolve, reject) => {
    client.exec(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function prepare(client, sql) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => err ? reject(err) : resolve(stmt));
  });
}

function applyPreparedStmt(stmt, params) {
  return new Promise((resolve, reject) => {
    stmt.exec(params, (err, affected) => err ? reject(err) : resolve(affected));
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[reconcile-legacyid] mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE'}`);

  const imsCreds = getImsCreds();
  const devCreds = getDevCreds();

  const ims = await connect(imsCreds, 'IMS prod');
  const dev = await connect(devCreds, 'DEV CAP HDI');
  await runStmt(dev, `SET SCHEMA "${devCreds.schema}"`);

  // ─── Read DEV TUTORIALS rows that have a slug ────────────────────────────
  const tutorialRows = await runStmt(dev,
    `SELECT ID, SLUG, LEGACYID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE SLUG IS NOT NULL`);
  console.error(`[reconcile-legacyid] DEV: ${tutorialRows.length} TUTORIALS with slugs`);

  if (tutorialRows.length === 0) {
    console.error('[reconcile-legacyid] nothing to do.');
    ims.end(); dev.end();
    process.exit(0);
  }

  // ─── Build IMS task-by-slug map ──────────────────────────────────────────
  // Pull all IMS tutorial tasks, group by derived slug.
  console.error(`[reconcile-legacyid] reading IMS tutorial tasks...`);
  const imsRows = await runStmt(ims,
    `SELECT ID, URL, TASK_STATUS FROM "IMSDBUSER"."IMS_TASK" WHERE TASK_TYPE = 'TUTORIAL' AND URL IS NOT NULL`);
  console.error(`[reconcile-legacyid] IMS: ${imsRows.length} tutorial tasks`);

  const imsTasksBySlug = new Map();
  let imsBadUrls = 0;
  for (const r of imsRows) {
    const slug = deriveSlug(r.URL);
    if (!slug) { imsBadUrls++; continue; }
    if (!imsTasksBySlug.has(slug)) imsTasksBySlug.set(slug, []);
    imsTasksBySlug.get(slug).push({ ID: Number(r.ID), URL: r.URL, TASK_STATUS: r.TASK_STATUS });
  }
  console.error(`[reconcile-legacyid] IMS: ${imsTasksBySlug.size} unique slugs, ${imsBadUrls} skipped (non-canonical URL)`);

  // ─── Compute plan (pure, testable) ───────────────────────────────────────
  const { updates, stats } = planUpdates(tutorialRows, imsTasksBySlug);

  if (VERBOSE) {
    for (const t of tutorialRows) {
      const slug = (t.SLUG || '').toLowerCase();
      const candidates = imsTasksBySlug.get(slug);
      if (!candidates || candidates.length === 0) {
        console.error(`  - tut ${t.ID.slice(0, 8)} slug=${t.SLUG}: no IMS match`);
      }
    }
  }

  console.error('');
  console.error('[reconcile-legacyid] resolution stats:');
  console.error(`  matched (will update):       ${stats.matched}`);
  console.error(`  already correct (skipped):   ${stats.alreadyCorrect}`);
  console.error(`  no IMS match:                ${stats.noImsMatch}`);
  console.error(`  only DELETED matches:        ${stats.onlyDeletedMatches}`);
  console.error(`  total IMS candidates seen:   ${stats.candidates}`);
  console.error('');

  // ─── Apply updates ───────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.error(`[reconcile-legacyid] DRY-RUN: would UPDATE ${updates.length} rows. Sample (first 5):`);
    for (const u of updates.slice(0, 5)) {
      console.error(`  tut ${u.tutorialId.slice(0, 8)} (${u.slug}): ${u.oldLegacyId} -> ${u.newLegacyId} [score=${u.score}]`);
      console.error(`    url=${u.url.slice(0, 120)}`);
    }
    ims.end(); dev.end();
    process.exit(stats.noImsMatch + stats.onlyDeletedMatches > 0 ? 2 : 0);
  }

  if (updates.length === 0) {
    console.error('[reconcile-legacyid] no updates to apply.');
    ims.end(); dev.end();
    process.exit(stats.noImsMatch + stats.onlyDeletedMatches > 0 ? 2 : 0);
  }

  console.error(`[reconcile-legacyid] LIVE: applying ${updates.length} UPDATE statements...`);
  const updateStmt = await prepare(dev,
    `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET LEGACYID = ? WHERE ID = ?`);
  let applied = 0;
  let failed = 0;
  for (const u of updates) {
    try {
      await applyPreparedStmt(updateStmt, [u.newLegacyId, u.tutorialId]);
      applied += 1;
      if (applied % 100 === 0) process.stderr.write(`  ${applied}/${updates.length}\r`);
    } catch (err) {
      failed += 1;
      if (failed <= 5) console.error(`  x tut ${u.tutorialId.slice(0, 8)}: ${err.message.slice(0, 80)}`);
    }
  }
  console.error(`\n[reconcile-legacyid] applied ${applied} updates (${failed} failed)`);

  ims.end(); dev.end();

  if (failed > 0 || stats.noImsMatch + stats.onlyDeletedMatches > 0) {
    process.exit(2);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`[reconcile-legacyid] FATAL: ${err.message}`);
  process.exit(1);
});
