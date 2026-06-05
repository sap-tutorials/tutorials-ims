#!/usr/bin/env node
/**
 * check-hana-rowcounts.cjs — pre/post-deploy row count tripwire for HDI deploys
 *
 * Filed as part of issue #257 prevention work after the 2026-06-05 HDI data loss.
 *
 * Usage:
 *   # Snapshot current row counts to a file
 *   npx cds bind --exec -- node scripts/check-hana-rowcounts.cjs --snapshot pre-deploy.json
 *
 *   # ... run mbt build && cf deploy ...
 *
 *   # Compare current state against the snapshot
 *   npx cds bind --exec -- node scripts/check-hana-rowcounts.cjs --diff pre-deploy.json
 *
 *   # One-shot: snapshot + immediate compare (no destructive deploy in between)
 *   #   useful as a smoke against current state. Exits 0 if all tables present.
 *   npx cds bind --exec -- node scripts/check-hana-rowcounts.cjs --probe
 *
 * Threshold rule (configurable via --threshold-pct=N):
 *   For every table where the snapshot showed at-or-above min-rows, the
 *   post-deploy count must remain at-or-above (snapshot * (1 - threshold-pct/100)).
 *   Default: 5% drop allowed for normal churn (admin deletes); larger drops fail.
 *   Empty tables in the snapshot (0 rows) are excluded — they can fluctuate freely.
 *
 * Exit codes:
 *   0 — within threshold or no snapshot file (probe mode)
 *   1 — connection or runtime error
 *   2 — row counts dropped beyond threshold (data-loss tripwire)
 *
 * Safety: read-only. Performs SELECT COUNT(*) only. Never writes.
 *
 * Output: human-readable to stderr, JSON to stdout if --json.
 */
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const hdb = require('hdb');
const { fmtRow, tripwireFailures } = require('./lib/hana-rowcount-helpers.cjs');

const args = process.argv.slice(2);
const SNAPSHOT_FILE = args.find(a => a.startsWith('--snapshot='))?.split('=')[1]
  ?? (args.indexOf('--snapshot') >= 0 ? args[args.indexOf('--snapshot') + 1] : null);
const DIFF_FILE = args.find(a => a.startsWith('--diff='))?.split('=')[1]
  ?? (args.indexOf('--diff') >= 0 ? args[args.indexOf('--diff') + 1] : null);
const PROBE = args.includes('--probe');
const JSON_OUT = args.includes('--json');
const THRESHOLD_PCT = Number(args.find(a => a.startsWith('--threshold-pct='))?.split('=')[1] ?? '5');
const MIN_ROW_THRESHOLD = Number(args.find(a => a.startsWith('--min-rows='))?.split('=')[1] ?? '10');

if (!SNAPSHOT_FILE && !DIFF_FILE && !PROBE) {
  console.error('Usage: --snapshot <file> | --diff <file> | --probe');
  console.error('  See header comment for full docs.');
  process.exit(1);
}

// ─── credentials ──────────────────────────────────────────────────────────────
function getCreds() {
  if (process.env.CDS_REQUIRES_DB_CREDENTIALS_JSON) {
    return JSON.parse(process.env.CDS_REQUIRES_DB_CREDENTIALS_JSON);
  }
  if (process.env.VCAP_SERVICES) {
    const v = JSON.parse(process.env.VCAP_SERVICES);
    const hana = (v.hana || []).find(s => s.name === 'tutorials-hana' || (s.tags || []).includes('hana'));
    if (hana) return hana.credentials;
  }
  // Fall back: shell out to cf service-key — execFileSync is shell-free / injection-safe.
  const out = execFileSync('cf', ['service-key', 'tutorials-hana', 'tutorials-hana-key'], { encoding: 'utf-8' });
  return JSON.parse(out.slice(out.indexOf('{'))).credentials;
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const client = hdb.createClient({
      host: c.host, port: parseInt(c.port, 10),
      user: c.user, password: c.password,
      useTLS: true, encrypt: true, sslValidateCertificate: false,
    });
    client.connect(err => err ? reject(err) : resolve(client));
  });
}

function runStmt(client, sql) {
  return new Promise((resolve, reject) => {
    client.exec(sql, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// ─── snapshot ─────────────────────────────────────────────────────────────────
async function snapshot(client, schema) {
  const rows = await runStmt(client,
    `SELECT TABLE_NAME, RECORD_COUNT FROM SYS.M_TABLES ` +
    `WHERE SCHEMA_NAME = '${schema}' AND TABLE_NAME LIKE 'COM_SAP_DEVELOPERS_IMS_%' ` +
    `ORDER BY TABLE_NAME`);
  const out = {};
  for (const r of rows) out[r.TABLE_NAME] = Number(r.RECORD_COUNT) || 0;
  return out;
}

// ─── main ─────────────────────────────────────────────────────────────────────
(async () => {
  let client;
  try {
    const creds = getCreds();
    client = await connect(creds);
    const schema = creds.schema;

    const current = await snapshot(client, schema);

    if (PROBE) {
      const tableCount = Object.keys(current).length;
      const totalRows = Object.values(current).reduce((a, b) => a + b, 0);
      console.error(`[probe] ${tableCount} CAP-managed tables, ${totalRows} total rows`);
      if (JSON_OUT) {
        process.stdout.write(JSON.stringify({ schema, host: creds.host, tableCount, totalRows, tables: current }, null, 2) + '\n');
      }
      process.exit(0);
    }

    if (SNAPSHOT_FILE) {
      const payload = {
        timestamp: new Date().toISOString(),
        host: creds.host,
        schema,
        tables: current,
      };
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload, null, 2));
      const tableCount = Object.keys(current).length;
      const totalRows = Object.values(current).reduce((a, b) => a + b, 0);
      console.error(`[snapshot] wrote ${SNAPSHOT_FILE} — ${tableCount} tables, ${totalRows} total rows`);
      process.exit(0);
    }

    if (DIFF_FILE) {
      if (!fs.existsSync(DIFF_FILE)) {
        console.error(`[diff] snapshot file not found: ${DIFF_FILE}`);
        process.exit(1);
      }
      const prev = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf-8'));
      if (prev.schema && prev.schema !== schema) {
        console.error(`[diff] WARNING: snapshot schema (${prev.schema}) != current (${schema}). Comparing anyway, but this may not be the same HDI container.`);
      }

      console.error(`[diff] comparing ${DIFF_FILE} (${prev.timestamp}) vs current state`);
      const allTables = new Set([...Object.keys(prev.tables), ...Object.keys(current)]);
      const lines = [];
      for (const name of [...allTables].sort()) {
        const line = fmtRow(name, prev.tables[name], current[name]);
        if (line) lines.push(line);
      }
      if (lines.length === 0) {
        console.error('  (no changes)');
      } else {
        for (const line of lines) console.error(line);
      }

      const failures = tripwireFailures(prev.tables, current, THRESHOLD_PCT, MIN_ROW_THRESHOLD);
      if (failures.length > 0) {
        console.error('');
        console.error(`[TRIPWIRE] ${failures.length} table(s) lost rows beyond ${THRESHOLD_PCT}% threshold:`);
        for (const f of failures) {
          console.error(`  ✗ ${f.name.replace(/^COM_SAP_DEVELOPERS_IMS_/, '')}: ${f.prev} → ${f.now} — ${f.reason}`);
        }
        if (JSON_OUT) {
          process.stdout.write(JSON.stringify({ ok: false, failures, prev: prev.tables, now: current }, null, 2) + '\n');
        }
        process.exit(2);
      }

      console.error('');
      console.error(`[OK] all tables within ${THRESHOLD_PCT}% threshold (min row threshold: ${MIN_ROW_THRESHOLD})`);
      if (JSON_OUT) {
        process.stdout.write(JSON.stringify({ ok: true, prev: prev.tables, now: current }, null, 2) + '\n');
      }
      process.exit(0);
    }
  } catch (err) {
    console.error(`[error] ${err.message}`);
    process.exit(1);
  } finally {
    if (client) client.end();
  }
})();
