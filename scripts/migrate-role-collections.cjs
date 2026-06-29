#!/usr/bin/env node
/**
 * Post-cutover verification + (if needed) restoration of XSUAA role-collection
 * user assignments for the tutorials-poc → tutorials-ims rename (#635).
 *
 * Workflow:
 *   1. node scripts/inventory-role-collections.cjs --subaccount tutorial-system \
 *        --out .migration-data/role-collections-pre-rename.json
 *      ← capture state BEFORE the cutover deploy.
 *
 *   2. cd .deploy && mbt build && cf deploy mta_archives/tutorials-ims_1.0.0.mtar \
 *        -e ../deploy/dev.mtaext -f
 *      ← the deploy itself recreates the 6 `Tutorials *` role collections with
 *        the new xsappname prefix. SUBACCOUNT-level user assignments survive
 *        the recreate because they bind by collection name, not template ref.
 *
 *   3. node scripts/migrate-role-collections.cjs \
 *        --inventory .migration-data/role-collections-pre-rename.json \
 *        --verify
 *      ← compare current assignments against the snapshot. Lists missing
 *        users per collection. Exits 0 if every user is still bound, 2 if
 *        anything is missing.
 *
 *   4. If --verify reports missing users:
 *      node scripts/migrate-role-collections.cjs \
 *        --inventory .migration-data/role-collections-pre-rename.json \
 *        --restore --commit
 *      ← re-asserts every assignment from the snapshot. Idempotent: users
 *        already bound get an "already" status, not a re-write.
 *
 * Why this isn't part of migrate-btp-roles.js:
 *   migrate-btp-roles.js carries an embedded source→target collection-name
 *   map (IMS_Admin_prod → Tutorials Admin, etc.) for the cross-subaccount
 *   IMS migration. The rename cutover is in-place — same subaccount, same
 *   collection names — so it doesn't fit that flow. Keeping it separate keeps
 *   the older script stable for any future cross-subaccount migration.
 */
'use strict';

const fs = require('node:fs');

async function loadBtpLib() {
  return await import('./lib/btp-cli.js');
}

const THROTTLE_MS = 100;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs(argv) {
  const out = {
    inventory: null,
    verify: false,
    restore: false,
    commit: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inventory') out.inventory = argv[++i];
    else if (a === '--verify') out.verify = true;
    else if (a === '--restore') out.restore = true;
    else if (a === '--commit') out.commit = true;
    else if (a === '--help' || a === '-h') {
      console.error(
        'Usage:\n' +
        '  migrate-role-collections.cjs --inventory <file> --verify\n' +
        '  migrate-role-collections.cjs --inventory <file> --restore [--commit]'
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.inventory) {
    console.error('Required: --inventory <path-to-snapshot>');
    process.exit(2);
  }
  if (!out.verify && !out.restore) {
    console.error('Pass either --verify or --restore.');
    process.exit(2);
  }
  if (out.verify && out.restore) {
    console.error('Pass --verify or --restore, not both.');
    process.exit(2);
  }
  if (out.restore && !out.commit) {
    console.log('[DRY RUN] Pass --commit to actually write assignments.');
  }
  return out;
}

function loadInventory(path) {
  if (!fs.existsSync(path)) {
    console.error(`Inventory file not found: ${path}`);
    console.error('Run scripts/inventory-role-collections.cjs first.');
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!data.collections || !Array.isArray(data.collections)) {
    console.error(`Inventory file ${path} is malformed (missing .collections array).`);
    process.exit(2);
  }
  return data;
}

async function assertSameSubaccount(btp, inventory) {
  const target = await btp.getCurrentTarget();
  if (!target || !target.subaccount) {
    console.error('btp target returned no subaccount. Run `btp login` first.');
    process.exit(2);
  }
  if (target.subaccount !== inventory.subaccount) {
    console.error(
      `Subaccount mismatch. Inventory was captured in "${inventory.subaccount}" ` +
      `but btp target is "${target.subaccount}". Switch subaccount first.`
    );
    process.exit(2);
  }
}

async function runVerify(btp, inventory) {
  console.log(`Verifying ${inventory.collections.length} role collections against snapshot from ${inventory.capturedAt}`);

  const issues = [];
  for (const snap of inventory.collections) {
    const current = await btp.getRoleCollectionUsers(snap.name);
    const currentKeys = new Set(current.map(u => `${u.origin}::${u.user}`));
    const missing = snap.users.filter(u => !currentKeys.has(`${u.origin}::${u.user}`));

    const verdict = missing.length === 0 ? 'OK' : `MISSING ${missing.length}/${snap.userCount}`;
    console.log(`  ${snap.name.padEnd(28)} pre=${String(snap.userCount).padStart(3)}  now=${String(current.length).padStart(3)}  ${verdict}`);

    if (missing.length > 0) {
      issues.push({ collection: snap.name, missing });
    }
  }

  if (issues.length === 0) {
    console.log('\n✓ All user assignments preserved through the rename. No action needed.');
    return 0;
  }

  console.log(`\n✗ ${issues.length} collection(s) lost user assignments:`);
  for (const i of issues) {
    console.log(`  ${i.collection}:`);
    for (const u of i.missing.slice(0, 10)) {
      console.log(`    - ${u.user} (${u.origin})`);
    }
    if (i.missing.length > 10) console.log(`    … and ${i.missing.length - 10} more`);
  }
  console.log('\nRun with --restore --commit to re-assert these assignments.');
  return 2;
}

async function runRestore(btp, inventory, commit) {
  const tag = commit ? 'RESTORE' : 'DRY-RUN';
  console.log(`[${tag}] Restoring ${inventory.collections.length} collections from snapshot.`);

  let okCount = 0, alreadyCount = 0, failedCount = 0;
  const failures = [];

  for (const snap of inventory.collections) {
    console.log(`  ${snap.name} (${snap.userCount} users)`);
    for (const u of snap.users) {
      if (!commit) {
        console.log(`    [dry-run] would assign ${u.user} (${u.origin})`);
        continue;
      }
      const res = await btp.assignUser(snap.name, u.user, u.origin);
      if (res.status === 'ok') {
        okCount++;
        console.log(`    + ${u.user}`);
      } else if (res.status === 'already') {
        alreadyCount++;
      } else {
        failedCount++;
        failures.push({ collection: snap.name, user: u.user, origin: u.origin, message: res.message });
        console.log(`    ✗ ${u.user}: ${res.message}`);
      }
      await sleep(THROTTLE_MS);
    }
  }

  if (!commit) {
    console.log(`\n[DRY RUN] would write ${inventory.collections.reduce((s, c) => s + c.userCount, 0)} assignments.`);
    console.log('Re-run with --commit to actually apply.');
    return 0;
  }

  console.log(`\nDone. ok=${okCount}  already=${alreadyCount}  failed=${failedCount}`);
  if (failedCount > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  ${f.collection}: ${f.user} (${f.origin}) — ${f.message}`);
    }
    return 1;
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const btp = await loadBtpLib();
  const inventory = loadInventory(args.inventory);

  await assertSameSubaccount(btp, inventory);

  const exitCode = args.verify
    ? await runVerify(btp, inventory)
    : await runRestore(btp, inventory, args.commit);

  process.exit(exitCode);
}

main().catch(err => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
