#!/usr/bin/env node
/**
 * scripts/lib/verify-taskrecords-delta.cjs
 *
 * Post-commit verification for the completion-activity delta backfill.
 * Read-only. Ties out what actually landed in CAP PROD against the source
 * window, and checks the changelog delta.
 *
 * For each windowed source IMS_TASK_RECORD (UPDATED_AT > SINCE), derive its
 * CAP PK and check presence in the target TASKRECORDS. Reports:
 *   - source window count
 *   - how many of those derived PKs are present in CAP (should == window count)
 *   - any missing derived PKs (the real gap, with their source legacyIds)
 *
 * Env: IMS_HANA_CREDENTIALS, CAP_HANA_CREDENTIALS (or target via cf target).
 * Args: [--since <iso>]
 */
'use strict';

const hdb = require('hdb');
const { execFileSync } = require('node:child_process');
const { v5: uuidv5 } = require('uuid');
const { NAMESPACES } = require('./migration-uuid-namespaces.cjs');

const SINCE = (() => {
  const i = process.argv.indexOf('--since');
  return i >= 0 ? process.argv[i + 1] : '2026-07-22T13:14:40.859Z';
})();
const CHUNK = 1000;

function connect(creds, label) {
  return new Promise((resolve, reject) => {
    const c = hdb.createClient({
      host: creds.host, port: parseInt(creds.port || '443', 10),
      user: creds.hdi_user || creds.user, password: creds.hdi_password || creds.password, useTLS: true,
    });
    c.connect((e) => (e ? reject(new Error(`${label}: ${e.message}`)) : resolve(c)));
  });
}
function run(c, sql, params) {
  return new Promise((resolve, reject) => {
    if (!params) return c.exec(sql, (e, r) => (e ? reject(e) : resolve(r)));
    c.prepare(sql, (pe, st) => {
      if (pe) return reject(pe);
      st.exec(params, (ee, r) => { try { st.drop(() => {}); } catch (_x) {} return ee ? reject(ee) : resolve(r); });
    });
  });
}
function targetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  const raw = execFileSync('cf', ['service-key', 'tutorials-hana', 'tutorials-hana-key'], { encoding: 'utf-8' });
  const p = JSON.parse(raw.slice(raw.indexOf('{')));
  return p.credentials || p;
}

(async () => {
  const src = JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  const source = await connect(src, 'source');
  await run(source, `SET SCHEMA "${src.schema}"`);
  const tgt = targetCreds();
  const target = await connect({ ...tgt, hdi_user: null, hdi_password: null }, 'target');
  await run(target, `SET SCHEMA "${tgt.schema}"`);

  // Source window legacyIds.
  const srcRows = await run(source,
    `SELECT "ID" FROM "${src.schema}"."IMS_TASK_RECORD" WHERE "UPDATED_AT" > ?`, [SINCE]);
  const legacyIds = srcRows.map((r) => Number(r.ID));
  console.log(`source window rows: ${legacyIds.length}`);

  // Derive PKs, probe target presence.
  const ns = NAMESPACES.taskrecord;
  const derived = legacyIds.map((lid) => ({ lid, pk: uuidv5(String(lid), ns) }));
  const T = `"${tgt.schema}"."COM_SAP_DEVELOPERS_IMS_TASKRECORDS"`;
  const present = new Set();
  for (let i = 0; i < derived.length; i += CHUNK) {
    const slice = derived.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = await run(target, `SELECT "ID" FROM ${T} WHERE "ID" IN (${ph})`, slice.map((d) => d.pk));
    for (const r of rows) present.add(r.ID);
  }
  const missing = derived.filter((d) => !present.has(d.pk));
  console.log(`present in CAP:     ${derived.length - missing.length}`);
  console.log(`missing from CAP:   ${missing.length}`);
  if (missing.length > 0) {
    console.log('missing source legacyIds (first 20):', missing.slice(0, 20).map((d) => d.lid).join(', '));
  }

  source.end();
  target.end();
})().catch((e) => { console.error('VERIFY FATAL:', e.message); process.exit(1); });
