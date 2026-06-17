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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
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
async function runImport() { throw new Error('not implemented'); }
async function runVerify() { throw new Error('not implemented'); }

// Allow `import` from tests without auto-running main(). On Windows the
// `===` comparison fails (process.argv[1] is a backslash path; import.meta.url
// is a forward-slash file:/// URL), so the endsWith() arm carries the load.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-btp-roles.js');
if (invokedDirectly) {
  main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
}
