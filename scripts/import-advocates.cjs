#!/usr/bin/env node
'use strict';

/**
 * import-advocates.cjs — Restore the Developer Advocate roster from a JSON snapshot.
 *
 * Reads .migration-data/advocates.json (produced by scripts/export-advocates.cjs)
 * and upserts each advocate into the currently-bound CAP database. Idempotent:
 * re-running converges target to match source. Topics/links/photo are
 * replace-not-merge.
 *
 * Uses raw cds.db.run() against entity-level CQN — no AdminService, no sharp
 * re-encoding, no after-handlers, no draft-table indirection.
 *
 * Spec: docs/superpowers/specs/2026-06-25-advocate-export-import-design.md
 *
 * Usage:
 *   cf login                              # to the target space (PROD typically)
 *   npm run import:advocates              # reads .migration-data/advocates.json
 *
 *   # Or explicitly:
 *   cds bind --exec -- node scripts/import-advocates.cjs
 *
 * Flags:
 *   --in <path>    Override the input file (default: .migration-data/advocates.json)
 */

const cds = require('@sap/cds');
const fs = require('fs');
const crypto = require('crypto');
const {
  VALID_REGIONS,
  VALID_LINK_KINDS,
  assertSchemaVersion,
  isHanaDb,
  advocateTableInfo,
} = require('./lib/advocate-io.cjs');

function parseArgs(argv) {
  const args = { in: '.migration-data/advocates.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') {
      if (i + 1 >= argv.length) { console.error('--in requires a value'); process.exit(2); }
      args.in = argv[++i];
    }
    else if (a === '--help' || a === '-h') {
      console.log(__filename, '- see header comment for usage');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.in)) {
    console.error(`[advocates-import] Input file not found: ${args.in}`);
    console.error(`[advocates-import] Run 'npm run export:advocates' first.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  assertSchemaVersion(payload);

  await cds.load('*');
  const db = await cds.connect.to('db');
  const isHana = isHanaDb(db);
  const T = advocateTableInfo(isHana);

  console.log(`[advocates-import] schemaVersion=${payload.schemaVersion}`);
  console.log(`[advocates-import] Source: ${payload.sourceDb || 'unknown'} (exported ${payload.exportedAt})`);
  console.log(`[advocates-import] Target DB kind: ${db.kind} (isHana=${isHana})`);
  console.log(`[advocates-import] Advocates in payload: ${payload.advocateCount}`);

  // ── TODO Task 5 onwards ───────────────────────────────────────────
  process.exit(0);
})().catch(err => {
  console.error('[advocates-import] FAILED:', err);
  process.exit(1);
});
