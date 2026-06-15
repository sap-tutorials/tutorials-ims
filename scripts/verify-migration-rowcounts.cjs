#!/usr/bin/env node
'use strict';

/**
 * Tier-A row-count verifier for the IMS → DEV cutover rehearsal.
 *
 * Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md
 *
 * Usage:
 *   node scripts/verify-migration-rowcounts.cjs [--output-dir=<path>] [--json] [--target-only]
 *
 * Source/target credentials follow the same resolution as migrate-from-hana.js.
 * --target-only skips IMS source connection (used for the preflight DEV snapshot
 * before IMS creds have been captured). In that mode every entity's sourceCount
 * is null and the tolerance check is skipped — exit 0 if all queries succeed.
 *
 * Exit codes: 0 all-pass | 1 any out-of-tolerance diff | 2 connection or query error.
 */

const { execFileSync } = require('child_process');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const hdb = require('hdb');

const { checkTolerance } = require('./lib/migration-tolerance.cjs');

// Entity → (source-table, target-table). Source schema is the legacy Java IMS;
// target is the CAP HDI container.
const ENTITY_TABLES = [
  ['tags',                  'IMS_TAG',                         'COM_SAP_DEVELOPERS_IMS_TAGS'],
  ['events',                'IMS_EVENT',                       'COM_SAP_DEVELOPERS_IMS_EVENTS'],
  ['groups',                'IMS_TASK',                        'COM_SAP_DEVELOPERS_IMS_GROUPS'],
  ['missions',              'IMS_TASK',                        'COM_SAP_DEVELOPERS_IMS_MISSIONS'],
  ['tutorials',             'IMS_TASK',                        'COM_SAP_DEVELOPERS_IMS_TUTORIALS'],
  ['steps',                 'IMS_TASK',                        'COM_SAP_DEVELOPERS_IMS_STEPS'],
  ['users',                 'IMS_USER',                        'COM_SAP_DEVELOPERS_IMS_USERS'],
  ['taskrecords',           'IMS_TASK_RECORD',                 'COM_SAP_DEVELOPERS_IMS_TASKRECORDS'],
  ['completionpaths',       'IMS_COMPLETION_PATH',             'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS'],
  ['completionpathitems',   'IMS_COMPLETION_PATH_TO_TASK',     'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS'],
  ['prizes',                'IMS_PRIZE',                       'COM_SAP_DEVELOPERS_IMS_PRIZES'],
  ['accomplishments',       'IMS_ACCOMPLISHMENT',              'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS'],
  ['accomplishmentrecords', 'IMS_ACCOMPLISHMENT_RECORD',       'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS'],
  ['prizerecords',          'IMS_PRIZE_RECORD',                'COM_SAP_DEVELOPERS_IMS_PRIZERECORDS'],
  ['tutorialtags',          'IMS_TAG_TO_TASK',                 'COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS'],
];

// These entities all live in IMS_TASK and need a TASK_TYPE filter on the source side.
const TASK_TYPE_FILTER = {
  groups: 'GROUP',
  missions: 'MISSION',
  tutorials: 'TUTORIAL',
  steps: 'STEP',
};

// ─── Connection helpers (mirror migrate-from-hana.js) ──────────────────────
function getCredentials(serviceInstance, serviceKey) {
  const raw = execFileSync('cf', ['service-key', serviceInstance, serviceKey], { encoding: 'utf-8' });
  const jsonStart = raw.indexOf('{');
  const parsed = JSON.parse(raw.slice(jsonStart));
  return parsed.credentials || parsed;
}

function connect(creds) {
  return new Promise((resolve, reject) => {
    const user = creds.hdi_user || creds.user;
    const password = creds.hdi_password || creds.password;
    const client = hdb.createClient({
      host: creds.host,
      port: parseInt(creds.port, 10),
      user,
      password,
      useTLS: true,
    });
    client.on('error', reject);
    client.connect((err) => err ? reject(err) : resolve(client));
  });
}

// HDB client method invocation; isolated in a helper so callers stay readable.
function runSql(client, sql) {
  const fn = client['exec'].bind(client);
  return new Promise((resolve, reject) =>
    fn(sql, (err, rows) => err ? reject(err) : resolve(rows)));
}

function resolveCreds(side) {
  const envName = side === 'source' ? 'IMS_HANA_CREDENTIALS' : 'CAP_HANA_CREDENTIALS';
  if (process.env[envName]) return JSON.parse(process.env[envName]);
  if (side === 'source') return getCredentials('ims-hana-prod-container', 'ims-hana-prod-container-key');
  return getCredentials('tutorials-hana', 'tutorials-hana-key');
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const outputDirArg = process.argv.find(a => a.startsWith('--output-dir='));
  const outputDir = outputDirArg ? outputDirArg.split('=')[1] : null;
  const jsonOnly = process.argv.includes('--json');
  const targetOnly = process.argv.includes('--target-only');

  let source, target;
  try {
    if (!targetOnly) {
      const sourceCreds = resolveCreds('source');
      source = await connect(sourceCreds);
      await runSql(source, `SET SCHEMA "${sourceCreds.schema}"`);
    }
    const targetCreds = resolveCreds('target');
    target = await connect({ ...targetCreds, hdi_user: null, hdi_password: null });
    await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);
  } catch (e) {
    console.error('✗ Connection error:', e.message);
    process.exit(2);
  }

  const results = [];
  for (const [name, sourceTable, targetTable] of ENTITY_TABLES) {
    try {
      const tgtSql = `SELECT COUNT(*) AS "C" FROM "${targetTable}"`;
      const [tgt] = await runSql(target, tgtSql);
      const targetCount = Number(tgt.C);

      if (targetOnly) {
        results.push({ name, sourceCount: null, targetCount, ok: true, diff: null, tolerance: null, class: null });
        continue;
      }

      const filter = TASK_TYPE_FILTER[name];
      const srcSql = filter
        ? `SELECT COUNT(*) AS "C" FROM "${sourceTable}" WHERE "TASK_TYPE" = '${filter}'`
        : `SELECT COUNT(*) AS "C" FROM "${sourceTable}"`;
      const [src] = await runSql(source, srcSql);
      const sourceCount = Number(src.C);
      const verdict = checkTolerance(name, sourceCount, targetCount);
      results.push({ name, sourceCount, targetCount, ...verdict });
    } catch (e) {
      results.push({ name, error: e.message.split('\n')[0] });
    }
  }

  if (source) source.disconnect();
  target.disconnect();

  if (!jsonOnly) {
    console.log('\nentity                  IMS_PROD     DEV       diff   tol  status');
    console.log('────────────────────  ──────────  ──────────  ──────  ────  ──────');
    for (const r of results) {
      if (r.error) {
        console.log(`${r.name.padEnd(22)} ERROR: ${r.error}`);
        continue;
      }
      const srcStr = r.sourceCount === null ? '       —  ' : String(r.sourceCount).padStart(10);
      const diffStr = r.diff === null ? '    —' : String(r.diff).padStart(5);
      const tolStr = r.tolerance === null ? ' — ' : `±${r.tolerance}`;
      const status = r.ok ? '✓' : '✗ FAIL';
      console.log(
        `${r.name.padEnd(22)} ${srcStr} ` +
        `${String(r.targetCount).padStart(10)}  ${diffStr}  ` +
        `${tolStr}    ${status}`
      );
    }
  }

  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, 'tier-a-rowcount-diff.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)
    );
  }

  if (results.some(r => r.error)) process.exit(2);
  if (results.some(r => r.ok === false)) process.exit(1);
  process.exit(0);
}

main();
