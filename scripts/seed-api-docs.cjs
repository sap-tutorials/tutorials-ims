#!/usr/bin/env node
// scripts/seed-api-docs.cjs
//
// Phase 4.5 (#746): operator CLI shim. Delegates to srv/lib/seed-api-docs.js.
//
// Usage:
//   node scripts/seed-api-docs.cjs --dry-run           # default
//   node scripts/seed-api-docs.cjs --commit
//   node scripts/seed-api-docs.cjs --commit --slug ad-cap_cqn_reference
//
// Why the CJS-shim / ESM-core split:
//   srv/admin-service.js is ESM. The shared loader at srv/lib/seed-api-docs.js
//   is ESM too, so it imports cleanly from both the admin handler (static
//   import) and this CJS shim (dynamic import). A CJS-only seed module would
//   need duplicating to call from admin-service.

const cds = require('@sap/cds');

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const commit = args.has('--commit');
  let slugFilter = null;
  const slugIdx = argv.indexOf('--slug');
  if (slugIdx >= 0) slugFilter = argv[slugIdx + 1];

  if (!commit && !args.has('--dry-run')) {
    console.log('seed-api-docs: defaulting to --dry-run (pass --commit to actually write)');
  }

  await cds.connect.to('db');
  // Dynamic import for the ESM module from this CJS shim.
  const { runSeedApiDocs } = await import('../srv/lib/seed-api-docs.js');
  const result = await runSeedApiDocs({ commit, slugFilter });
  console.log(`seed-api-docs: planned=${result.planned} committed=${result.committed} commit=${commit}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
