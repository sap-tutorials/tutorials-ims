#!/usr/bin/env node
/**
 * Migrate BTP role-collection user assignments from one subaccount to another.
 * See docs/developers/operations/btp-role-migration.md for the runbook.
 *
 * Subcommands:
 *   export                 Read the active subaccount → .migration-data/btp-roles.json
 *   import --dry-run       Preview what would be written to the active subaccount
 *   import --confirm       Actually call `btp assign ...` per assignment
 *   verify                 Re-read active subaccount, diff against the export
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assignUser,
  getCurrentTarget,
  listRoleCollections,
  getRoleCollectionUsers,
} from './lib/btp-cli.js';

// IMS Prod role collection name → new tutorial-system role collection name.
// Filled in after the first `export` run reveals the actual IMS-side names.
// The `export` subcommand will fail loudly if any source collection is not
// listed here (or in SKIP_BUILTIN_PREFIXES below), which is the intended
// discover-first behavior.
//
// TEST-ONLY: BTP_ROLES_MAP_OVERRIDE env var (JSON) replaces this map at module
// load. Used by scripts/__tests__/migrate-btp-roles.test.ts so tests can seed
// a known mapping without modifying source. Production runs MUST NOT set it.
function parseRoleCollectionMap() {
  if (!process.env.BTP_ROLES_MAP_OVERRIDE) {
    return {
      // 'IMS Admin':         'Tutorials Admin',
      // 'IMS SuperAdmin':    'Tutorials SuperAdmin',
      // 'IMS ContentAuthor': 'Tutorials Author',
      // 'IMS Developer':     'Tutorials Developer',
      // 'IMS Display':       'Tutorials Display',
      // 'IMS Scanner':       'Tutorials Scanner',
    };
  }
  try {
    const parsed = JSON.parse(process.env.BTP_ROLES_MAP_OVERRIDE);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('value must be a JSON object');
    }
    return parsed;
  } catch (err) {
    console.error(`BTP_ROLES_MAP_OVERRIDE is not valid JSON object: ${err.message}`);
    process.exit(2);
  }
}

export const ROLE_COLLECTION_MAP = parseRoleCollectionMap();

// Built-in BTP role collections — never copied. They're pre-provisioned by
// the new global account and managed independently.
export const SKIP_BUILTIN_PREFIXES = [
  'Subaccount ',
  'Cloud Connector ',
  'Connectivity ',
  'Destination ',
];

const OUTPUT_FILE = process.env.BTP_ROLES_OUTPUT || '.migration-data/btp-roles.json';
const IMPORT_LOG = process.env.BTP_ROLES_IMPORT_LOG || '.migration-data/btp-roles-import.log.json';

function isBuiltin(name) {
  return SKIP_BUILTIN_PREFIXES.some(p => name.startsWith(p));
}

function parseImportFlags(argv) {
  const dryRun = argv.includes('--dry-run');
  const confirm = argv.includes('--confirm');
  if (dryRun && confirm) {
    console.error('Pass either --dry-run or --confirm, not both.');
    process.exit(2);
  }
  if (!dryRun && !confirm) {
    console.error('Pass --dry-run to preview, or --confirm to actually write.');
    process.exit(2);
  }
  return { dryRun, confirm };
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'export': return await runExport();
    case 'import': return await runImport();
    case 'verify': return await runVerify();
    default:
      console.error('Usage: migrate-btp-roles.js <export|import|verify> [flags]');
      process.exit(2);
  }
}

// Stubs filled in by later steps:
async function runExport() {
  const target = await getCurrentTarget();
  if (!target.subaccountId) {
    console.error('Could not determine current btp target. Run `btp login` and `btp target -sa <id>` first.');
    process.exit(1);
  }

  const collections = await listRoleCollections();

  const exported = [];
  const discoveredButUnmapped = [];
  const skippedBuiltins = [];

  for (const rc of collections) {
    const name = rc.name;
    if (isBuiltin(name)) { skippedBuiltins.push(name); continue; }
    if (!(name in ROLE_COLLECTION_MAP)) { discoveredButUnmapped.push(name); continue; }
    const users = await getRoleCollectionUsers(name);
    exported.push({
      sourceName: name,
      description: rc.description || '',
      users,
    });
  }

  const out = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: {
      globalAccount: target.globalAccountSubdomain,
      subaccountId: target.subaccountId,
      subaccountSubdomain: target.subaccountSubdomain,
    },
    roleCollections: exported,
    discoveredButUnmapped,
    skippedBuiltins,
  };

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));

  const totalAssignments = exported.reduce((n, c) => n + c.users.length, 0);
  console.log(`Exported ${exported.length} mapped collections (${totalAssignments} assignments) → ${OUTPUT_FILE}`);
  if (discoveredButUnmapped.length > 0) {
    console.log(`\n${discoveredButUnmapped.length} discovered but UNMAPPED — add to ROLE_COLLECTION_MAP:`);
    for (const n of discoveredButUnmapped) console.log(`  - ${n}`);
    console.log('\nNote: --show-user-assignments only shows DIRECTLY assigned users.');
    console.log('Group/attribute-mapped role collections need separate handling.');
  }
  if (skippedBuiltins.length > 0) {
    console.log(`\nSkipped ${skippedBuiltins.length} built-in BTP collections.`);
  }
}
/**
 * Sequentially assign each user in the export to their mapped role collection
 * on the currently-targeted subaccount.
 *
 * Throttled at 100 ms between calls to be polite to the BTP control plane.
 * Wall-clock ≈ N × (CLI ~200 ms + 100 ms throttle). For N > 500 consider a
 * pooled variant with concurrency 4–8.
 *
 * In `--dry-run` mode, prints `[dry-run] would assign ...` lines and skips
 * both the actual `btp assign` call AND writing the log file. In `--confirm`
 * mode, calls `assignUser`, classifies ok/already/failed, persists the per-call
 * result to IMPORT_LOG, and exits 1 if any assignment failed.
 */
async function runAssignmentLoop(exportDoc, target, flags) {
  const log = [];
  let okCount = 0, alreadyCount = 0, failCount = 0;

  for (const rc of exportDoc.roleCollections) {
    const targetName = ROLE_COLLECTION_MAP[rc.sourceName];
    for (const { user, origin } of rc.users) {
      if (flags.dryRun) {
        console.log(`[dry-run] would assign "${targetName}" to ${user} (origin=${origin})`);
        log.push({ collection: targetName, user, origin, status: 'dry-run' });
        continue;
      }
      const result = await assignUser(targetName, user, origin);
      log.push({ collection: targetName, user, origin, status: result.status, message: result.message });
      if (result.status === 'ok')      { okCount++;      console.log(`[ok]      ${targetName} ← ${user}`); }
      else if (result.status === 'already') { alreadyCount++; console.log(`[already] ${targetName} ← ${user}`); }
      else                              { failCount++;    console.error(`[FAIL]    ${targetName} ← ${user}: ${result.message}`); }
      // Be polite to the BTP control plane.
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Summary. Real runs persist the log; dry-run does not (no mutations under
  // .migration-data/ from a "preview" call).
  if (!flags.dryRun) {
    mkdirSync(dirname(IMPORT_LOG), { recursive: true });
    writeFileSync(IMPORT_LOG, JSON.stringify({
      importedAt: new Date().toISOString(),
      target: { subaccountId: target.subaccountId, subaccountSubdomain: target.subaccountSubdomain },
      flags: { dryRun: !!flags.dryRun, confirm: !!flags.confirm },
      summary: { ok: okCount, already: alreadyCount, failed: failCount },
      entries: log,
    }, null, 2));
  }

  console.log(`\nImport summary (target subaccount: ${target.subaccountSubdomain || target.subaccountId})`);
  console.log(`  Collections processed: ${exportDoc.roleCollections.length}`);
  if (flags.dryRun) {
    console.log(`  Dry-run lines:         ${log.length}`);
    console.log(`  No log written (dry-run).`);
  } else {
    console.log(`  Assignments OK:        ${okCount}`);
    console.log(`  Already-assigned:      ${alreadyCount}`);
    console.log(`  Failed:                ${failCount}`);
    console.log(`  Log written: ${IMPORT_LOG}`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

async function runImport() {
  const flags = parseImportFlags(process.argv);

  // 1. Export file exists.
  if (!existsSync(OUTPUT_FILE)) {
    console.error(`Export file not found: ${OUTPUT_FILE}\nRun 'export' against the source subaccount first.`);
    process.exit(1);
  }
  const exportDoc = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));

  // 2. Current btp target.
  const target = await getCurrentTarget();
  if (!target.subaccountId) {
    console.error('Could not determine current btp target. Run `btp login` and `btp target -sa <id>` first.');
    process.exit(1);
  }

  // 3. Source != target. Re-targeting safety belt.
  if (target.subaccountId === exportDoc.source?.subaccountId) {
    console.error(
      `Refusing to import: target subaccount equals source subaccount (${target.subaccountId}).\n` +
      `You're connected to the same subaccount the export came from. Re-target with \`btp target -sa <new-id>\`.`
    );
    process.exit(1);
  }

  // 4. Every mapped target collection exists on the target subaccount.
  const targetCollections = await listRoleCollections();
  const targetNames = new Set(targetCollections.map(c => c.name));
  const missing = [];
  for (const rc of exportDoc.roleCollections) {
    const targetName = ROLE_COLLECTION_MAP[rc.sourceName];
    if (!targetName) {
      console.error(`Export contains "${rc.sourceName}" but ROLE_COLLECTION_MAP has no entry. Did the script change after export?`);
      process.exit(1);
    }
    if (!targetNames.has(targetName)) missing.push(targetName);
  }
  if (missing.length > 0) {
    const uniqueMissing = [...new Set(missing)].sort();
    console.error(`Target subaccount is missing these mapped role collections:\n  - ${uniqueMissing.join('\n  - ')}\nDeploy xs-security.json or fix the mapping table.`);
    process.exit(1);
  }

  await runAssignmentLoop(exportDoc, target, flags);
}
async function runVerify() {
  if (!existsSync(OUTPUT_FILE)) {
    console.error(`Export file not found: ${OUTPUT_FILE}`);
    process.exit(1);
  }
  const exportDoc = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));

  const target = await getCurrentTarget();
  if (target.subaccountId === exportDoc.source?.subaccountId) {
    console.error(`Refusing to verify: btp target points at the source subaccount, not the import target.`);
    process.exit(1);
  }

  let totalMissing = 0, totalExtra = 0;
  const skippedUnmapped = [];
  for (const rc of exportDoc.roleCollections) {
    const targetName = ROLE_COLLECTION_MAP[rc.sourceName];
    if (!targetName) { skippedUnmapped.push(rc.sourceName); continue; }

    const targetUsers = await getRoleCollectionUsers(targetName);
    const expected = new Set(rc.users.map(u => `${u.user}|${u.origin}`));
    const actual   = new Set(targetUsers.map(u => `${u.user}|${u.origin}`));

    const missing = [...expected].filter(k => !actual.has(k));
    const extra   = [...actual].filter(k => !expected.has(k));

    console.log(`\n${targetName}`);
    console.log(`  expected ${expected.size}, found ${actual.size}, missing ${missing.length}, extra ${extra.length}`);
    // Column-aligned: '[missing] ' (10 chars) and '[extra]   ' (10 chars) so the
    // keys line up in terminal output. Don't "fix" the spacing.
    for (const k of missing) console.log(`    [missing] ${k}`);
    for (const k of extra)   console.log(`    [extra]   ${k}`);

    totalMissing += missing.length;
    totalExtra   += extra.length;
  }

  if (skippedUnmapped.length > 0) {
    console.warn(`\nSkipped ${skippedUnmapped.length} unmapped source collection(s): ${skippedUnmapped.join(', ')}`);
    console.warn('  These appear in the export but have no entry in ROLE_COLLECTION_MAP.');
    console.warn('  Their users were NOT verified on the target.');
  }

  console.log(`\nVerify summary: ${totalMissing} missing, ${totalExtra} extra`);
  process.exit(totalMissing > 0 ? 1 : 0);
}

// Allow `import` from tests without auto-running main(). On Windows the
// `===` comparison fails (process.argv[1] is a backslash path; import.meta.url
// is a forward-slash file:/// URL), so the endsWith() arm carries the load.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-btp-roles.js');
if (invokedDirectly) {
  main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
}
