#!/usr/bin/env node
/**
 * Pre-flight inventory of XSUAA role collections + their user assignments,
 * for the tutorials-poc → tutorials-ims rename cutover (#635).
 *
 * Why this exists separately from migrate-btp-roles.js:
 *   migrate-btp-roles.js is for CROSS-SUBACCOUNT user-assignment migration
 *   (the old IMS prod → tutorial-system cutover). This script is for
 *   IN-PLACE rename: same subaccount, but the xsappname prefix on the
 *   underlying scopes flips. The 6 `Tutorials *` role collections are
 *   declared inline in xs-security.json, so `cf update-service tutorials-xsuaa
 *   -c xs-security.json` recreates them with the new prefix automatically.
 *   Existing user/group assignments at the SUBACCOUNT level survive that
 *   recreate because they're keyed on collection NAME, not template ref.
 *
 *   This script's job is therefore a SAFETY SNAPSHOT:
 *     - Capture every Tutorials * collection definition + assignment BEFORE
 *       the cutover, so we have a deterministic rollback artifact.
 *     - Output is consumed by migrate-role-collections.cjs in restore mode
 *       if step 2 fails.
 *
 * Usage:
 *   node scripts/inventory-role-collections.cjs --subaccount <name> \
 *     --out .migration-data/role-collections-pre-rename.json
 *
 * Requires `btp` CLI logged into the target subaccount (the --subaccount flag
 * is a sanity assertion, not a target switch — the script refuses to run if
 * `btp target` doesn't match).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// We use the existing scripts/lib/btp-cli.js helpers (ESM). This file is .cjs
// to match the other rename-related cutover scripts and the deploy runbook
// references; load the ESM helpers via dynamic import().
async function loadBtpLib() {
  const lib = await import('./lib/btp-cli.js');
  return lib;
}

const COLLECTION_PREFIX = 'Tutorials ';   // matches the 6 collections in xs-security.json
const DEFAULT_OUT = '.migration-data/role-collections-pre-rename.json';

function parseArgs(argv) {
  const out = { subaccount: null, outFile: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--subaccount') out.subaccount = argv[++i];
    else if (a === '--out') out.outFile = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.error('Usage: inventory-role-collections.cjs --subaccount <name> [--out <path>]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.subaccount) {
    console.error('Required: --subaccount <name>. Match the value in `btp target` output.');
    process.exit(2);
  }
  return out;
}

async function main() {
  const { subaccount, outFile } = parseArgs(process.argv);
  const btp = await loadBtpLib();

  const target = await btp.getCurrentTarget();
  if (!target || !target.subaccount) {
    console.error('btp target returned no subaccount. Run `btp login` first.');
    process.exit(2);
  }
  if (target.subaccount !== subaccount) {
    console.error(
      `Subaccount mismatch. --subaccount=${subaccount} but btp target shows ${target.subaccount}. ` +
      `Run \`btp target --subaccount ${subaccount}\` first.`
    );
    process.exit(2);
  }

  console.log(`Targeting subaccount: ${target.subaccount} (${target.globalAccount || 'unknown global'})`);

  const collections = await btp.listRoleCollections();
  const tutorialsCollections = collections.filter(c =>
    (c.name || c.roleCollectionName || '').startsWith(COLLECTION_PREFIX)
  );

  if (tutorialsCollections.length === 0) {
    console.error(
      `No role collections starting with "${COLLECTION_PREFIX}" found. ` +
      `Either xs-security.json has not yet been deployed in this subaccount, ` +
      `or the collection naming convention has drifted.`
    );
    process.exit(2);
  }

  console.log(`Found ${tutorialsCollections.length} Tutorials * role collections.`);

  const inventory = {
    capturedAt: new Date().toISOString(),
    subaccount: target.subaccount,
    globalAccount: target.globalAccount,
    expectedXsappname: 'tutorials-poc',   // what we expect pre-rename
    collections: [],
  };

  for (const c of tutorialsCollections) {
    const name = c.name || c.roleCollectionName;
    console.log(`  → ${name}`);
    const users = await btp.getRoleCollectionUsers(name);
    inventory.collections.push({
      name,
      description: c.description || null,
      // role-template-references the cockpit shows — useful for diffing,
      // not strictly needed for rebind (the inline xs-security.json owns
      // the canonical definition).
      roleReferences: c.roleReferences || c.roles || [],
      users,
      userCount: users.length,
    });
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(inventory, null, 2));

  const totalUsers = inventory.collections.reduce((sum, c) => sum + c.userCount, 0);
  console.log('');
  console.log(`Wrote ${outFile}`);
  console.log(`  ${inventory.collections.length} collections, ${totalUsers} user assignments total.`);
  console.log('');
  console.log('Next step: run the cutover deploy. If anything fails, this snapshot is your rollback artifact.');
}

main().catch(err => {
  console.error('Inventory failed:', err.message);
  process.exit(1);
});
