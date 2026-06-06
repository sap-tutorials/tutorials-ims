#!/usr/bin/env node
/**
 * scrape-deployer-log.cjs — surface HDI rollback / drop / undeploy warnings
 *
 * Filed as part of issue #257 prevention work after the 2026-06-05 HDI data loss.
 *
 * Reads the recent CF logs from `tutorials-db-deployer` (or accepts a saved
 * log file via --file) and looks for danger patterns that indicate a deploy
 * may have caused data loss:
 *
 *   - "Rolled back" — a previous deploy was reverted; HDI may have torn down
 *     intermediate state including tables
 *   - "deleted files not in undeploy.json" — schema artifacts removed without
 *     being explicitly listed for undeploy; CF/HDI may handle these by
 *     dropping the tables
 *   - "TABLE_REPLACE" — explicit table-replace operation; ALWAYS data-impacting
 *   - "DROP TABLE" — direct DDL drop logged by HDI
 *   - "Files to undeploy: [non-empty]" — HDI WILL drop those artifacts
 *
 * Usage:
 *   node scripts/scrape-deployer-log.cjs                    # current logs
 *   node scripts/scrape-deployer-log.cjs --file ./db.log    # offline log
 *   node scripts/scrape-deployer-log.cjs --json             # JSON to stdout
 *   node scripts/scrape-deployer-log.cjs --app tutorials-db-deployer-qa
 *
 * Exit codes:
 *   0 — no danger patterns found
 *   1 — runtime/connection error
 *   2 — danger pattern detected
 */
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { scan } = require('./lib/deployer-log-helpers.cjs');

const args = process.argv.slice(2);
const FILE = args.find(a => a.startsWith('--file='))?.split('=')[1]
  ?? (args.indexOf('--file') >= 0 ? args[args.indexOf('--file') + 1] : null);
const APP_NAME = args.find(a => a.startsWith('--app='))?.split('=')[1]
  ?? (args.indexOf('--app') >= 0 ? args[args.indexOf('--app') + 1] : 'tutorials-db-deployer');
const JSON_OUT = args.includes('--json');

function fetchLogs() {
  if (FILE) {
    if (!fs.existsSync(FILE)) {
      console.error(`[error] log file not found: ${FILE}`);
      process.exit(1);
    }
    return fs.readFileSync(FILE, 'utf-8');
  }
  // execFileSync — shell-free, injection-safe.
  try {
    return execFileSync('cf', ['logs', APP_NAME, '--recent'], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    console.error(`[error] cf logs ${APP_NAME} --recent failed: ${err.message}`);
    process.exit(1);
  }
}

const logs = fetchLogs();
const findings = scan(logs);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    app: FILE ? `(file: ${FILE})` : APP_NAME,
    lineCount: logs.split('\n').length,
    findings,
    ok: findings.filter(f => f.severity === 'CRITICAL').length === 0,
  }, null, 2) + '\n');
}

if (findings.length === 0) {
  console.error(`[OK] no danger patterns in ${FILE ? FILE : `cf logs ${APP_NAME} --recent`} (${logs.split('\n').length} lines)`);
  process.exit(0);
}

const critical = findings.filter(f => f.severity === 'CRITICAL');
const warnings = findings.filter(f => f.severity === 'WARNING');

console.error(`[scrape] ${findings.length} finding(s) in ${FILE ? FILE : `cf logs ${APP_NAME}`}: ${critical.length} CRITICAL, ${warnings.length} WARNING`);
for (const f of findings) {
  const tag = f.severity === 'CRITICAL' ? '🚨' : '⚠️ ';
  console.error(`  ${tag} L${f.lineNumber} [${f.severity}] ${f.description}`);
  console.error(`     ${f.excerpt}`);
}

if (critical.length > 0) {
  console.error('');
  console.error('[FAIL] critical pattern(s) detected — review the deploy before proceeding');
  process.exit(2);
}

console.error('');
console.error('[OK] only warnings; review but not blocking');
process.exit(0);
