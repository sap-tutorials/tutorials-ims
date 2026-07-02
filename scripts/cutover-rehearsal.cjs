#!/usr/bin/env node
'use strict';

/**
 * Cutover rehearsal orchestrator — drives the IMS-prod → DEV migration end-to-end.
 *
 * Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md
 *
 * Usage:
 *   node scripts/cutover-rehearsal.cjs [--no-act]
 *
 *   --no-act    Halt after Step 4 (the documented non-action). Used for smoke-testing
 *               the early steps without touching IMS prod or DEV.
 *
 * Each step writes its stdout+stderr to <OUTPUT_DIR>/<NN>-<step>.log in addition to
 * the console. On any non-zero exit, the runner halts and prints the failed log path.
 *
 * OUTPUT_DIR = .migration-data/cutover-<ISO-timestamp>/
 */

const { spawnSync } = require('child_process');
const { writeFileSync, mkdirSync, createWriteStream, readFileSync, renameSync, existsSync } = require('fs');
const { join } = require('path');
const readline = require('readline');

const NO_ACT = process.argv.includes('--no-act');

// Heap bump for the migrator: even with TaskRecords paginated, Users (~786k rows)
// and Tags (~10k rows × wide) can push past Node's default 4 GB heap. 12 GB is
// safely above that on a developer laptop. Issue #332.
const MIGRATOR_NODE_FLAGS = ['--max-old-space-size=12288'];

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = join('.migration-data', `cutover-${TIMESTAMP}`);

const IMS_BASE_URL = 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_BASE_URL = 'https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com';

// ─── Logging helpers ──────────────────────────────────────────────────────────
function makeLog(num, name) {
  return join(OUTPUT_DIR, `${String(num).padStart(2, '0')}-${name}.log`);
}

function fail(num, name, msg) {
  console.error(`\n✗ Step ${num} (${name}) failed: ${msg}`);
  console.error(`  Log: ${makeLog(num, name)}`);
  process.exit(1);
}

function banner(num, name) {
  console.log(`\n▸ Step ${num}: ${name}`);
  console.log('─'.repeat(72));
}

// Run a child command, tee stdout+stderr to console AND a log file.
// Returns the exit code.
function runChild(num, name, command, args, env = {}) {
  const logPath = makeLog(num, name);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} ${command} ${args.join(' ')} ===\n`);

  // Use spawnSync with stdio: ['inherit', 'pipe', 'pipe'] so the child can read
  // from this process's stdin (for prompts in migrate-from-hana.js if any) but
  // we capture and tee its output.
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
    shell: false,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
    logStream.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
    logStream.write(result.stderr);
  }
  logStream.end();

  if (result.error) {
    fail(num, name, result.error.message);
  }
  return result.status ?? 1;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

// ─── Step 1: Verify cf target = tutorial-system / dev ─────────────────────────
function step1() {
  banner(1, 'Verify cf target = tutorial-system / dev');
  const result = spawnSync('cf', ['target'], { encoding: 'utf-8', shell: false });
  if (result.status !== 0) {
    fail(1, 'cf-target', `cf target exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  const out = result.stdout;
  console.log(out);
  writeFileSync(makeLog(1, 'cf-target'), out);

  const orgMatch = out.match(/^org:\s+(.*)$/m);
  const spaceMatch = out.match(/^space:\s+(.*)$/m);
  const org = orgMatch ? orgMatch[1].trim() : '?';
  const space = spaceMatch ? spaceMatch[1].trim() : '?';

  if (org !== 'tutorial-system' || space !== 'dev') {
    fail(1, 'cf-target', `Expected org=tutorial-system space=dev, got org=${org} space=${space}. Run: cf target -o tutorial-system -s dev`);
  }
  console.log(`  ✓ org=${org} space=${space}`);

  // Issue #363: assert exactly one approuter app exists in the target space.
  // Duplicate-app drift is a real hazard — during the 2026-06-16 rehearsal an
  // accidental `cf push tutorials-approuter` (the bare module name) had landed
  // alongside the canonical `tutorials-dev-approuter`, and a manual rolling
  // deploy crashed the wrong one.
  const appsResult = spawnSync('cf', ['apps'], { encoding: 'utf-8', shell: false });
  if (appsResult.status !== 0) {
    fail(1, 'cf-apps', `cf apps exited ${appsResult.status}: ${appsResult.stderr || appsResult.stdout}`);
  }
  const approuterRows = appsResult.stdout
    .split(/\r?\n/)
    .filter((line) => /\bapprouter\b/.test(line) && !/^name\s+requested\s+state/i.test(line));
  if (approuterRows.length === 0) {
    fail(1, 'cf-apps', 'No *approuter* app found in this space. Deploy the MTA first.');
  }
  if (approuterRows.length > 1) {
    fail(1, 'cf-apps',
      `Found ${approuterRows.length} *approuter* apps in this space. Exactly one expected.\n` +
      approuterRows.map((r) => '    ' + r).join('\n') + '\n\n' +
      'Duplicate-app drift hazard. Recovery: cf delete <leftover-name> -f -r. ' +
      'See docs/developers/operations/mta-deployment.md → "Canonical app names per environment".');
  }
  console.log(`  ✓ exactly one approuter: ${approuterRows[0].trim().split(/\s+/)[0]}`);
}

// ─── Step 2: Snapshot DEV row counts → preflight-rowcounts.json ───────────────
async function step2() {
  banner(2, 'Snapshot current DEV row counts');
  const preflightDir = join(OUTPUT_DIR, 'preflight');
  // --target-only: skip IMS source connection. We just need the DEV state
  // recorded as a recovery anchor before the wipe in Step 9.
  const code = runChild(2, 'preflight-rowcounts',
    'node', ['scripts/verify-migration-rowcounts.cjs', `--output-dir=${preflightDir}`, '--target-only', '--json']);
  const jsonPath = join(preflightDir, 'tier-a-rowcount-diff.json');
  if (!existsSync(jsonPath)) {
    fail(2, 'preflight-rowcounts', `Snapshot not produced. Verifier exit=${code}.`);
  }
  // Rename to spec-required filename.
  const finalPath = join(OUTPUT_DIR, 'preflight-rowcounts.json');
  renameSync(jsonPath, finalPath);
  console.log(`  ✓ Snapshot at ${finalPath}`);
}

// ─── Step 3: Preflight env check — CONTENT_API_KEY on tutorials-srv ───────────
function step3() {
  banner(3, 'Preflight env check: CONTENT_API_KEY on tutorials-srv');
  const result = spawnSync('cf', ['env', 'tutorials-srv'], { encoding: 'utf-8', shell: false });
  if (result.status !== 0) {
    fail(3, 'cf-env', `cf env tutorials-srv exited ${result.status}`);
  }
  writeFileSync(makeLog(3, 'cf-env'), result.stdout);
  if (!/CONTENT_API_KEY/.test(result.stdout)) {
    fail(3, 'cf-env',
      'CONTENT_API_KEY not set on tutorials-srv. Without it, the post-migration ' +
      'content rebuild (Step 13) will fail. Remediation:\n' +
      '  cf set-env tutorials-srv CONTENT_API_KEY "<DEV-content-api-key — fetch from BTP credstore, do NOT commit>"\n' +
      '  cf restart tutorials-srv');
  }
  console.log('  ✓ CONTENT_API_KEY is set');
}

// ─── Step 4: Document non-action — tutorials-srv left running ─────────────────
function step4() {
  banner(4, 'Documented non-action: tutorials-srv left running');
  const note =
    'tutorials-srv stays UP throughout the migration. Background jobs (cleanup,\n' +
    'ngds-retry, account-merge) may fire during the run; their noise is part of\n' +
    'the rehearsal. Do NOT cf stop tutorials-srv.\n\n' +
    'Per spec §Decisions row 11.\n';
  console.log(note);
  writeFileSync(makeLog(4, 'non-action-note'), note);
}

// ─── Step 5: IMS prod org switch + source-creds capture ───────────────────────
async function step5() {
  banner(5, 'Capture IMS prod source credentials');
  console.log('Switch cf target to the IMS prod org now.');
  console.log('  cf target -o "Developer Destination_IMS" -s DEV');
  console.log('');
  const ack = await prompt('Press Enter once cf is on the IMS org, or type "abort" to halt: ');
  if (ack.trim().toLowerCase() === 'abort') {
    fail(5, 'ims-org-switch', 'aborted by operator');
  }
  // Fetch service-key for the IMS HDI container.
  const result = spawnSync('cf', ['service-key', 'ims-hana-prod-container', 'ims-hana-prod-container-key'],
    { encoding: 'utf-8', shell: false });
  if (result.status !== 0) {
    fail(5, 'ims-service-key', `cf service-key failed: ${result.stderr || result.stdout}`);
  }
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) {
    fail(5, 'ims-service-key', 'no JSON found in cf service-key output');
  }
  const parsed = JSON.parse(result.stdout.slice(jsonStart));
  const creds = parsed.credentials || parsed;
  const credsPath = join(OUTPUT_DIR, 'source-creds.json');
  writeFileSync(credsPath, JSON.stringify(creds, null, 2));
  writeFileSync(makeLog(5, 'ims-service-key'), result.stdout);
  console.log(`  ✓ Source credentials cached at ${credsPath}`);

  console.log('\nNow switch cf target back to tutorial-system / dev:');
  console.log('  cf target -o tutorial-system -s dev');
  await prompt('Press Enter once cf is back on tutorial-system/dev: ');
}

// ─── Helper: load source creds + fetch fresh target creds ─────────────────────
function loadEnvCreds() {
  const sourcePath = join(OUTPUT_DIR, 'source-creds.json');
  const sourceCreds = JSON.parse(readFileSync(sourcePath, 'utf-8'));
  const result = spawnSync('cf', ['service-key', 'tutorials-hana', 'tutorials-hana-key'],
    { encoding: 'utf-8', shell: false });
  if (result.status !== 0) {
    throw new Error(`cf service-key tutorials-hana failed: ${result.stderr || result.stdout}`);
  }
  const jsonStart = result.stdout.indexOf('{');
  const parsed = JSON.parse(result.stdout.slice(jsonStart));
  const targetCreds = parsed.credentials || parsed;
  return {
    IMS_HANA_CREDENTIALS: JSON.stringify(sourceCreds),
    CAP_HANA_CREDENTIALS: JSON.stringify(targetCreds),
  };
}

// ─── Step 6: Discover source schema ───────────────────────────────────────────
function step6() {
  banner(6, 'Migrator --discover (connectivity probe)');
  const env = loadEnvCreds();
  const code = runChild(6, 'discover', 'node', [...MIGRATOR_NODE_FLAGS, 'scripts/migrate-from-hana.js', '--discover'], env);
  if (code !== 0) fail(6, 'discover', `migrate-from-hana --discover exited ${code}`);
}

// ─── Step 7: Dry-run migration ────────────────────────────────────────────────
function step7() {
  banner(7, 'Migrator --dry-run (mapRow sanity check)');
  const env = loadEnvCreds();
  const code = runChild(7, 'dry-run', 'node', [...MIGRATOR_NODE_FLAGS, 'scripts/migrate-from-hana.js', '--dry-run'], env);
  if (code !== 0) fail(7, 'dry-run', `migrate-from-hana --dry-run exited ${code}`);
}

// ─── Step 8: Confirmation gate ────────────────────────────────────────────────
async function step8() {
  banner(8, 'Confirmation gate');
  console.log('About to wipe and overwrite tutorials-hana DEV with IMS prod data.');
  console.log('This will DELETE every row in 16 entities before re-inserting.');
  const answer = await prompt('Type WIPE to continue, anything else to abort: ');
  if (answer.trim() !== 'WIPE') {
    fail(8, 'confirmation', `aborted (got "${answer}")`);
  }
  writeFileSync(makeLog(8, 'confirmation'), 'operator typed WIPE\n');
  console.log('  ✓ Confirmation received');
}

// ─── Step 9: Real migration ───────────────────────────────────────────────────
// Captures the migration window (start → end) so Step 10 can compute realistic
// activity-class tolerances. Issue #361.
let migrationStartMs = null;
let migrationEndMs = null;

function step9() {
  banner(9, 'Migrator (real run)');
  const env = loadEnvCreds();
  migrationStartMs = Date.now();
  const code = runChild(9, 'migrate', 'node', [...MIGRATOR_NODE_FLAGS, 'scripts/migrate-from-hana.js'], env);
  migrationEndMs = Date.now();
  if (code !== 0) fail(9, 'migrate', `migrate-from-hana exited ${code}`);
}

// ─── Step 9.5: Post-migration data setup (slug population) ────────────────────
// Required after every migration: the migrator does not derive slugs for
// Missions or CompletionPaths, leaving them NULL. Without slugs:
//   - /build/navigator filter `mission.published = true AND tut.slug IS NOT NULL`
//     still matches (since published defaults to TRUE) but mission/group
//     navigation URLs fall back to legacyId
//   - /browse/ static page counts missions/groups as 0 because the Hugo build
//     filters out rows whose slug looks like a numeric legacyId
// scripts/setup-dev-data.cjs does TWO things post-migration:
//   1. Deletes any "autotest" cruft (no-op on prod-data migration)
//   2. Assigns slugs from .migration-data/slug-mapping.json (87 missions + 66
//      groups for the legacy hand-curated set), then derives slugs from titles
//      for the remaining rows
// Discovered missing in Sitting 2.5 rehearsal — past loads ran this manually.
function step9_5() {
  banner('9.5', 'Post-migration: populate Mission/CompletionPath slugs');
  // Use cds bind --exec because setup-dev-data.cjs imports @sap/cds and needs
  // a HANA binding resolved at startup.
  const code = runChild('9_5', 'setup-dev-data',
    'npx', ['cds', 'bind', '--exec', '--', 'node', 'scripts/setup-dev-data.cjs']);
  if (code !== 0) fail('9.5', 'setup-dev-data', `setup-dev-data.cjs exited ${code}`);
}

// ─── Step 9.6: Backfill TutorialMeta owner+reviewedDate from IMS source ──────
// The main migrator skips TutorialMeta (CAP-era entity), but IMS prod's
// IMS_TUTORIAL_META holds 1,428 real-world author assignments + review status
// that DO matter for Tutorial Health. This backfill closes that gap.
//
// PR #355 — surfaced when 2026-06-16 rehearsal showed Tutorial Health rows
// with blank Owner / Last Reviewed columns. UPDATEs use COALESCE so non-NULL
// DEV values are never overwritten; idempotent across re-runs.
function step9_6() {
  banner('9.6', 'Backfill TutorialMeta owner + reviewedDate from IMS source');
  const env = loadEnvCreds();
  const code = runChild('9_6', 'backfill-tutorial-meta',
    'node', ['scripts/backfill-tutorial-meta-from-ims.cjs'], env);
  if (code !== 0) fail('9.6', 'backfill-tutorial-meta', `backfill exited ${code}`);
}

// ─── Step 9.7: Sync Mission/Group published flag from AEM sitemap ─────────────
// The AEM-replacement curation gate (`Missions.published` / `Groups.published`,
// PR #349) needs a signal to decide which 87/193 of the 888/359 migrated rows
// should land as published. AEM's sitemap is the source of truth: every
// publicly-visible mission appears as `mission.<slug>.html`; same for groups.
//
// The script fetches the sitemap, fetches each mission/group page, matches
// AEM page <title> to DB Missions.title / Groups.title, and applies:
//   UPDATE Missions/Groups SET published=false everywhere
//   UPDATE Missions/Groups SET published=true on AEM-matched rows
//
// PR #356 — surfaced when 2026-06-16 rehearsal showed 370/203 published
// (every non-DELETED row) where IMS prod navigator showed 86/194.
function step9_7() {
  banner('9.7', 'Sync Missions/Groups published flag from AEM sitemap');
  const env = loadEnvCreds();
  // Source creds not needed; this script only writes to DEV.
  const code = runChild('9_7', 'aem-published-sync',
    'node', ['scripts/sync-published-flag-from-aem-sitemap.cjs'],
    { CAP_HANA_CREDENTIALS: env.CAP_HANA_CREDENTIALS });
  if (code !== 0) fail('9.7', 'aem-published-sync', `aem-published-sync exited ${code}`);
}

// ─── Step 9.8: Apply curated TutorialMeta owner overrides ────────────────────
// Issue #371: IMS_TUTORIAL_AUTHOR.EMAIL contains synthetic placeholder
// addresses for ~225 of 1,396 tutorials (e.g.
// "noreply-tutorial-cleanup@sap-tutorials.local" or
// "<id>+<github>@users.noreply.github.com"). Step 9.6's backfill now
// FILTERS those placeholders out (leaves OWNER=NULL), so this step rewrites
// the small set of placeholder rows we have a verified mapping for back to
// their real corporate emails. Currently covers Thomas Jung's 68 tutorials;
// extend the OVERRIDES table in the script as more authors are
// human-verified.
function step9_8() {
  banner('9.8', 'Apply curated TutorialMeta owner overrides (Issue #371)');
  const env = loadEnvCreds();
  // Target-only; no source connection needed.
  const code = runChild('9_8', 'apply-owner-overrides',
    'node', ['scripts/apply-tutorialmeta-owner-overrides.cjs'],
    { CAP_HANA_CREDENTIALS: env.CAP_HANA_CREDENTIALS });
  if (code !== 0) fail('9.8', 'apply-owner-overrides', `apply-owner-overrides exited ${code}`);
}

// ─── Step 10: Tier A row-count verify ─────────────────────────────────────────
function step10() {
  banner(10, 'Tier A: row-count verifier');
  const env = loadEnvCreds();

  // Issue #361: pass the migration window so the verifier can scale
  // activity-class tolerances proportionally. Defaults to undefined when
  // step9 didn't run (e.g. partial replay), letting the verifier fall back
  // to its 2-hour assumption.
  const verifierArgs = ['scripts/verify-migration-rowcounts.cjs', `--output-dir=${OUTPUT_DIR}`];
  if (migrationStartMs && migrationEndMs) {
    const seconds = Math.ceil((migrationEndMs - migrationStartMs) / 1000);
    verifierArgs.push(`--migration-window-seconds=${seconds}`);
    console.log(`  Migration window: ${seconds}s (≈${Math.round(seconds / 60)}min)`);
  }

  const code = runChild(10, 'verify-rowcounts', 'node', verifierArgs, env);
  if (code === 1) fail(10, 'verify-rowcounts', 'row-count diff out of tolerance');
  if (code === 2) fail(10, 'verify-rowcounts', 'connection or query error');
  if (code !== 0) fail(10, 'verify-rowcounts', `unexpected exit ${code}`);
}

// ─── Step 11: Tier B endpoint parity ──────────────────────────────────────────
function step11() {
  banner(11, 'Tier B: endpoint parity (compare-systems.js)');
  const env = { IMS_BASE_URL, CAP_BASE_URL };
  const code = runChild(11, 'parity', 'node', ['scripts/compare-systems.js'], env);
  if (code !== 0) {
    console.warn(`  ⚠ compare-systems.js exited ${code} — review log before continuing`);
  }
}

// ─── Step 12: Tier C smoke checklist ──────────────────────────────────────────
function step12() {
  banner(12, 'Tier C: functional smoke checklist');
  const checklist = `# Tier C functional smoke

Walk these 14 items in a browser. Mark each with [x] when verified.

[ ] 1. Open https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/me/
       Log in via SAP IDP. Name, avatar, progress count visible.
[ ] 2. /me/ Recent Activity timeline shows ≥3 prior completions; slugs match real history.
[ ] 3. /me/ accomplishments strip renders earned badges.
[ ] 4. /me/ prize-claim history visible if any claims.
[ ] 5. /browse/ — homepage loads, mission tiles render with NEW badges, license icons, category facet.
[ ] 6. Open one mission tile, completion ring shows progress.
[ ] 7. Click into one previously-completed tutorial → green check on completed steps, "Continue" lands correctly.
[ ] 8. Click into one not-yet-completed tutorial, complete one step, reload → step persists.
[ ] 9. /admin-ui/#missions-display — Fiori list shows ~87 missions.
[ ] 10. /admin-ui/#users-display — Fiori list shows ~47k users (paged).
[ ] 11. /scanner-ui/ — scan a known account number, prize stats render.
[ ] 12. /admin/analytics — run one canned query, ≥1 row returned.
[ ] 13. cf logs tutorials-dev-approuter --recent — no 5xx, no auth loop.
[ ] 14. cf logs tutorials-srv --recent — no LOB-locator-expiry, no FK violations from background jobs.

Notes / findings:

`;
  const checklistPath = join(OUTPUT_DIR, 'smoke-checklist.md');
  writeFileSync(checklistPath, checklist);
  console.log(checklist);
  console.log(`Checklist written to ${checklistPath}`);
}

// ─── Step 13: Content rebuild prompt ──────────────────────────────────────────
async function step13() {
  banner(13, 'Trigger content rebuild?');
  console.log('Tutorial HTML in HANA was wiped by Step 9. Without rebuild, /tutorials/* will 404.');
  const answer = await prompt('Trigger gh workflow run rebuild-content.yml now? [y/N]: ');
  if (answer.trim().toLowerCase() === 'y') {
    const code = runChild(13, 'content-rebuild', 'gh', ['workflow', 'run', 'rebuild-content.yml']);
    if (code !== 0) fail(13, 'content-rebuild', `gh workflow run exited ${code}`);
    console.log('  ✓ Workflow dispatched. Watch with: gh run watch');
  } else {
    console.log('Skipped. To run later: gh workflow run rebuild-content.yml');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Cutover rehearsal artifact dir: ${OUTPUT_DIR}\n`);

  step1();
  await step2();
  step3();
  step4();
  if (NO_ACT) {
    console.log('\n--no-act flag set; halting after Step 4.');
    process.exit(0);
  }
  await step5();
  step6();
  step7();
  await step8();
  step9();
  step9_5();
  step9_6();
  step9_7();
  step9_8();
  step10();
  step11();
  step12();
  await step13();

  console.log(`\n✓ Cutover rehearsal complete. Artifacts: ${OUTPUT_DIR}`);
}

main().catch((e) => {
  console.error('\n✗ Fatal error:', e.message);
  process.exit(1);
});
