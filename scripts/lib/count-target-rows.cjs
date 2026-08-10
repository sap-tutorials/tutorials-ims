#!/usr/bin/env node
/**
 * scripts/lib/count-target-rows.cjs
 * Read-only: print COUNT(*) for a target CAP table. Verification helper.
 * Env: CAP_HANA_CREDENTIALS or target via cf target (tutorials-hana key).
 * Args: <UPPERCASE_TABLE_NAME>
 */
'use strict';
const hdb = require('hdb');
const { execFileSync } = require('node:child_process');

const table = process.argv[2];
if (!table) { console.error('Usage: count-target-rows.cjs <TABLE>'); process.exit(2); }

function targetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  const raw = execFileSync('cf', ['service-key', 'tutorials-hana', 'tutorials-hana-key'], { encoding: 'utf-8' });
  const p = JSON.parse(raw.slice(raw.indexOf('{')));
  return p.credentials || p;
}
const tgt = targetCreds();
const c = hdb.createClient({ host: tgt.host, port: parseInt(tgt.port || '443', 10), user: tgt.user, password: tgt.password, useTLS: true });
c.connect((e) => {
  if (e) { console.error('connect:', e.message); process.exit(1); }
  c.exec(`SELECT COUNT(*) AS "C" FROM "${tgt.schema}"."${table}"`, (er, rows) => {
    if (er) { console.error('query:', er.message); process.exit(1); }
    console.log(`${table}: ${rows[0].C} rows`);
    c.end();
  });
});
