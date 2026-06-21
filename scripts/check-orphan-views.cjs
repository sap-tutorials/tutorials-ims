#!/usr/bin/env node
/* eslint-disable */
// scripts/check-orphan-views.cjs
//
// Post-deploy CI safety net: enumerate views in the HDI container's HANA
// schema and compare them to what the latest build artifacts in
// gen/db/src/gen/ declare. Any view that exists in HANA but not in the
// archive is an ORPHAN — left over from a previous build that emitted it
// (e.g. via @analytics.exposed) but where the annotation has since been
// removed. Orphans rot silently until the underlying column changes, at
// which point HDI tries to "redeploy dependent objects", finds the SQL
// invalid, and fails the next deploy. PR #519 fixed one such orphan
// (ANALYTICSSERVICE_TUTORIALREPOSITORIES) on 2026-06-21; this script
// makes the next one a CI signal instead of a deploy blocker.
//
// Credentials come from (in order):
//   1. CDS_REQUIRES_DB_CREDENTIALS_JSON env var
//   2. VCAP_SERVICES env var (in-CF case)
//   3. `cf service-key tutorials-hana tutorials-hana-key` (CI default after cf login)
//
// We can also be pointed at the QA container via --service-instance=tutorials-hana-qa.
//
// Exit codes:
//   0 — no orphans found
//   1 — orphan(s) detected (CI: treat as warning, not fail — see deploy.yml peer steps)
//   2 — fatal error (cannot read gen/, cannot connect to DB, etc.)
//
// Output:
//   --json on stdout for CI to parse; human-readable to stderr otherwise.
//
// Read-only. Performs SELECT only. Never writes.

'use strict';

const fs    = require('node:fs');
const path  = require('node:path');
const cp    = require('node:child_process');
const hdb   = require('hdb');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const SERVICE_INSTANCE = args.find(a => a.startsWith('--service-instance='))?.split('=')[1]
  ?? 'tutorials-hana';
const SERVICE_KEY = args.find(a => a.startsWith('--service-key='))?.split('=')[1]
  ?? `${SERVICE_INSTANCE}-key`;

const GEN_DIR = path.resolve(__dirname, '..', 'gen', 'db', 'src', 'gen');

// CDS-generated artifacts use `.hdbview` for SELECT-only views. We don't
// audit `.hdbcalculationview` / `.hdbprocedure` / `.hdbsynonym` here —
// they have their own lifecycle and weren't the source of the 2026-06-21
// regression. Easy to extend later if a similar failure mode surfaces.
const ARTIFACT_GLOB = /\.hdbview$/;

function fatal(msg, err) {
  process.stderr.write(`FATAL: ${msg}\n`);
  if (err) process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(2);
}

function readArtifactSet(dir = GEN_DIR) {
  if (!fs.existsSync(dir)) {
    fatal(`${dir} does not exist. Run \`cds build --production\` first.`);
  }
  const files = fs.readdirSync(dir).filter(f => ARTIFACT_GLOB.test(f));
  // Filename → HANA view name. CDS emits `AdminService.Foo.hdbview` and HANA
  // calls the view `ADMINSERVICE_FOO` (uppercase, dots → underscores).
  const set = new Set();
  for (const f of files) {
    const base = f.replace(/\.hdbview$/, '');
    set.add(artifactToHanaName(base));
  }
  return set;
}

// Pure helper, exported for unit tests. Defines the filename → HANA-view-name
// contract. CDS emits dot-delimited filenames; HANA stores identifiers
// uppercase + underscore-delimited (unless quoted).
function artifactToHanaName(basename) {
  return basename.replace(/\.hdbview$/, '').replace(/\./g, '_').toUpperCase();
}

module.exports = { artifactToHanaName };

function getCreds() {
  if (process.env.CDS_REQUIRES_DB_CREDENTIALS_JSON) {
    return JSON.parse(process.env.CDS_REQUIRES_DB_CREDENTIALS_JSON);
  }
  if (process.env.VCAP_SERVICES) {
    const v = JSON.parse(process.env.VCAP_SERVICES);
    const hana = (v.hana || []).find(s => s.name === SERVICE_INSTANCE || (s.tags || []).includes('hana'));
    if (hana) return hana.credentials;
  }
  // Fall back: cf service-key shell-out. We use execFileSync (NOT exec) — it
  // takes argv as an array, never invokes a shell, and SERVICE_INSTANCE /
  // SERVICE_KEY come from --argv flags (developer-controlled, not network).
  // Same pattern as scripts/check-hana-rowcounts.cjs.
  let out;
  try {
    out = cp.execFileSync('cf', ['service-key', SERVICE_INSTANCE, SERVICE_KEY], { encoding: 'utf-8' });
  } catch (e) {
    fatal(`cf service-key ${SERVICE_INSTANCE} ${SERVICE_KEY} failed. Are you logged in to the right CF org/space?`, e);
  }
  const idx = out.indexOf('{');
  if (idx < 0) fatal(`Unexpected output from cf service-key: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(idx)).credentials;
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

// Gate the entry point so `require('./check-orphan-views.cjs')` from tests
// imports the helpers without running the HANA-query path.
if (require.main === module) {
  (async () => {
  const artifactNames = readArtifactSet();
  if (artifactNames.size === 0) {
    fatal('no .hdbview files found in gen/db/src/gen/. Did `cds build --production` fail silently?');
  }

  const creds = getCreds();
  const client = await connect(creds).catch(e => fatal('HANA connect failed', e));

  // SYS.VIEWS lives in the system schema; CURRENT_SCHEMA filters to just this
  // HDI container. _DRAFTS views are intentional (Fiori draft tables) — exclude
  // them so they don't show as "missing" pending.
  const rows = await runStmt(client, `
    SELECT VIEW_NAME
      FROM SYS.VIEWS
     WHERE SCHEMA_NAME = CURRENT_SCHEMA
       AND VIEW_NAME NOT LIKE '%_DRAFTS'
     ORDER BY VIEW_NAME
  `).catch(e => { client.end(); fatal('SYS.VIEWS query failed', e); });

  client.end();

  const hanaViews = new Set(rows.map(r => r.VIEW_NAME));

  // Orphan = in HANA, not in archive. We don't report the reverse direction
  // (in archive, not in HANA) as a failure because that's a normal pre-deploy
  // state — HDI is about to create the view on next deploy. We DO surface it
  // in --json for diagnostic completeness.
  const orphans = [...hanaViews].filter(v => !artifactNames.has(v)).sort();
  const pending = [...artifactNames].filter(v => !hanaViews.has(v)).sort();

  const summary = {
    hanaViewCount: hanaViews.size,
    artifactCount: artifactNames.size,
    orphanCount: orphans.length,
    pendingCount: pending.length,
    serviceInstance: SERVICE_INSTANCE,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ summary, orphans, pending }, null, 2) + '\n');
  } else {
    process.stderr.write(`HANA views in ${SERVICE_INSTANCE}:    ${hanaViews.size}\n`);
    process.stderr.write(`gen/ .hdbview artifacts:     ${artifactNames.size}\n`);
    process.stderr.write(`Orphans (in HANA, not in archive): ${orphans.length}\n`);
    process.stderr.write(`Pending (in archive, not deployed): ${pending.length}\n`);
    if (orphans.length > 0) {
      process.stderr.write('\n=== ORPHAN VIEWS ===\n');
      for (const v of orphans) process.stderr.write(`  - ${v}\n`);
      process.stderr.write(
        '\nTo fix: add the corresponding `src/gen/<Service>.<Entity>.hdbview` path\n' +
        'to `db/undeploy.json`, then rebuild + redeploy. Reference: memory file\n' +
        '`hdi_orphan_views_from_removed_annotations.md` (PR #519).\n'
      );
    }
  }

  process.exit(orphans.length > 0 ? 1 : 0);
  })().catch(e => fatal('unexpected error', e));
}
