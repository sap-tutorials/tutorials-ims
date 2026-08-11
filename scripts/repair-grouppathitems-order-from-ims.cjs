/**
 * repair-grouppathitems-order-from-ims.cjs  (issue #1592)
 *
 * WHY THIS EXISTS
 * ---------------
 * The original IMS→CAP migration derived group→tutorial ordering from
 *   ROW_NUMBER() OVER (PARTITION BY parent ORDER BY CHILD_TASK_ID)
 * (see migrate-from-hana.js:1453 and backfill-task-hierarchy-from-ims.cjs:158).
 * CHILD_TASK_ID is the tutorial's internal task ID — arbitrary w.r.t. display
 * order. The authoritative authored sequence lives in IMS_TASK_TO_PARENT.TASK_ORDER,
 * which the migrator correctly used for Steps and CompletionPathItems but NOT for
 * GroupPathItems. Result: 194/196 multi-tutorial groups in PROD sit in the wrong,
 * task-id-ascending order (issue #1592: hana-cloud-mission-trial group shows 4,1,2,3).
 *
 * This script re-reads IMS_TASK_TO_PARENT.TASK_ORDER (schema IMSDBUSER) and mirrors
 * it into COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS.ITEMORDER, keyed by row ID. It is:
 *   - read-only by default (--dry-run implied unless --commit is passed)
 *   - idempotent / re-runnable (UPDATE by row ID; no inserts/deletes)
 *   - order-preserving for groups already correct (writes only where itemOrder differs)
 *   - able to SKIP specific groups (the 2 hand-corrected in Admin UI) via --skip-slug
 *
 * SOURCE creds (IMS, read-only):  IMS_HANA_CREDENTIALS json  OR
 *                                 IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD
 * TARGET creds (CAP/PROD):        CAP_HANA_CREDENTIALS json  (service-key JSON)
 *
 * Usage:
 *   # 1) dry-run — writes a full before/after CSV, mutates nothing:
 *   IMS_DB_URL=... IMS_DB_USERNAME=... IMS_DB_PASSWORD=... \
 *   CAP_HANA_CREDENTIALS=$(cat prod-creds.json) \
 *   node scripts/repair-grouppathitems-order-from-ims.cjs
 *
 *   # 2) commit — same, but applies the UPDATEs in a single transaction:
 *   ... node scripts/repair-grouppathitems-order-from-ims.cjs --commit
 *
 * Flags:
 *   --commit                 Apply writes. Without it, DRY RUN (default).
 *   --skip-slug=<group-slug> Exclude a group from writes (repeatable). Default skips
 *                            the two 2026-08-10 hand-corrected groups (see DEFAULT_SKIP).
 *   --no-default-skip        Do NOT auto-skip the default hand-corrected groups.
 *   --out=<path>             CSV report path (default .migration-data/repair-1592.<mode>.csv)
 *   --verbose                Per-group logging.
 */

'use strict';

const hdb = require('hdb');
const fs = require('fs');
const path = require('path');

const COMMIT = process.argv.includes('--commit');
const VERBOSE = process.argv.includes('--verbose');
const NO_DEFAULT_SKIP = process.argv.includes('--no-default-skip');
const MODE = COMMIT ? 'commit' : 'dryrun';

// The two groups Tom hand-corrected in Admin UI on 2026-08-10 (issue #1592
// discussion). Preserve unless --no-default-skip is passed. Decision: "Preserve
// my edits" — IMS repair skips these even if IMS TASK_ORDER differs.
const DEFAULT_SKIP = new Set([
  'set-up-your-sap-hana-cloud-sap-hana-database-and-understand-the-basics',
  'deploy-a-full-stack-cap-application-in-sap-btp-kyma-runtime-following-sap-btp-developer-s-guide',
]);

const skipSlugs = new Set(NO_DEFAULT_SKIP ? [] : DEFAULT_SKIP);
for (const a of process.argv) {
  const m = a.match(/^--skip-slug=(.+)$/);
  if (m) skipSlugs.add(m[1].trim().toLowerCase());
}
const OUT = (() => {
  const a = process.argv.find(x => x.startsWith('--out='));
  if (a) return a.slice('--out='.length);
  return path.join('.migration-data', `repair-1592.${MODE}.csv`);
})();

const T = 'COM_SAP_DEVELOPERS_IMS_';

function connectHana(creds) {
  const port = parseInt(creds.port || '443', 10);
  const client = hdb.createClient({
    host: creds.host, port, user: creds.user, password: creds.password, useTLS: true,
  });
  return new Promise((resolve, reject) => {
    client.connect((err) => (err ? reject(err) : resolve(client)));
  });
}
function runSql(client, sql, params) {
  if (params) {
    return new Promise((resolve, reject) => {
      client.prepare(sql, (err, stmt) => {
        if (err) return reject(err);
        stmt.exec(params, (err2, rows) => { stmt.drop(); err2 ? reject(err2) : resolve(rows); });
      });
    });
  }
  return new Promise((resolve, reject) =>
    client.exec(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function resolveSourceCreds() {
  if (process.env.IMS_HANA_CREDENTIALS) return JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  // File form (avoids passing secrets on the command line / through transcripts):
  //   IMS_CREDS_FILE=<path> or default .migration-data/ims-creds.json
  const f = process.env.IMS_CREDS_FILE || path.join('.migration-data', 'ims-creds.json');
  if (fs.existsSync(f)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Accept either {host,port,user,password,schema} or {IMS_DB_URL,...} shapes.
    if (j.host) return { schema: 'IMSDBUSER', ...j };
    if (j.IMS_DB_URL) {
      const url = new URL(String(j.IMS_DB_URL).replace('jdbc:sap://', 'https://'));
      return { host: url.hostname, port: url.port || '443', user: j.IMS_DB_USERNAME,
        password: j.IMS_DB_PASSWORD, schema: url.searchParams.get('currentschema') || 'IMSDBUSER' };
    }
  }
  if (process.env.IMS_DB_URL) {
    const url = new URL(process.env.IMS_DB_URL.replace('jdbc:sap://', 'https://'));
    return {
      host: url.hostname, port: url.port || '443',
      user: process.env.IMS_DB_USERNAME, password: process.env.IMS_DB_PASSWORD,
      schema: url.searchParams.get('currentschema') || 'IMSDBUSER',
    };
  }
  throw new Error('No IMS source creds. Provide .migration-data/ims-creds.json, IMS_CREDS_FILE, ' +
    'IMS_HANA_CREDENTIALS, or IMS_DB_URL+IMS_DB_USERNAME+IMS_DB_PASSWORD.');
}
function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  // Preferred: run under `cds bind --exec` so VCAP_SERVICES carries the CAP HANA
  // binding — no service-key materialization into the shell/transcript.
  if (process.env.VCAP_SERVICES) {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    const hana = (vcap.hana || vcap['hana-cloud'] || []).find(s => s && s.credentials);
    if (hana) {
      const c = hana.credentials;
      return {
        host: c.host, port: c.port || '443',
        user: c.user || c.hdi_user, password: c.password || c.hdi_password,
        schema: c.schema,
      };
    }
  }
  throw new Error('No CAP target creds. Run via `cds bind --to tutorials-hana:hdi-shared --exec` ' +
    'or set CAP_HANA_CREDENTIALS to the service-key JSON.');
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async function main() {
  const src = resolveSourceCreds();
  const tgt = resolveTargetCreds();
  const srcSchema = src.schema || 'IMSDBUSER';
  console.log(`Source (IMS):  ${String(src.host).slice(0, 32)}... schema=${srcSchema}`);
  console.log(`Target (CAP):  ${String(tgt.host).slice(0, 32)}... schema=${tgt.schema}`);
  console.log(MODE === 'commit' ? '=== COMMIT — writes WILL be applied ===' : '=== DRY RUN — no writes ===');
  if (skipSlugs.size) console.log(`Skipping ${skipSlugs.size} group(s): ${[...skipSlugs].join(', ')}`);

  const source = await connectHana(src);
  const target = await connectHana(tgt);

  // Pin schemas so unqualified table names resolve regardless of the connect
  // user's default. IMS source query qualifies with "${srcSchema}"; CAP query
  // uses unqualified COM_SAP_DEVELOPERS_IMS_* which live in the container schema.
  if (tgt.schema) await runSql(target, `SET SCHEMA "${tgt.schema}"`);

  // 1) Authoritative order from IMS: parent GROUP -> child TUTORIAL, with TASK_ORDER.
  const imsRows = await runSql(source, `
    SELECT ttp."PARENT_TASK_ID" AS "GROUP_LEGACYID",
           ttp."CHILD_TASK_ID"  AS "TUT_LEGACYID",
           ttp."TASK_ORDER"     AS "TASK_ORDER"
    FROM "${srcSchema}"."IMS_TASK_TO_PARENT" ttp
    INNER JOIN "${srcSchema}"."IMS_TASK" p ON p."ID" = ttp."PARENT_TASK_ID"
    INNER JOIN "${srcSchema}"."IMS_TASK" c ON c."ID" = ttp."CHILD_TASK_ID"
    WHERE p."TASK_TYPE" = 'GROUP' AND c."TASK_TYPE" = 'TUTORIAL'`);
  console.log(`IMS: ${imsRows.length} group→tutorial links read`);

  // desired[groupLegacyId][tutLegacyId] = normalized itemOrder (authoritative).
  //
  // Java IMS uses 0-based TASK_ORDER; CAP's itemOrder is 1-based (existing PROD
  // rows are 1..N, and the step migration normalizes with +1 — migrate-from-hana.js:1251).
  // We mirror that convention so the repaired rows match both the hand-corrected
  // groups and CAP's publish path. Relative order is unaffected by the offset;
  // this keeps the absolute values consistent (no 0 vs 1 drift).
  const desired = new Map(); // key `${g}:${t}` -> 1-based itemOrder
  const imsNullOrder = [];   // links where TASK_ORDER is null/undefined
  for (const r of imsRows) {
    const g = Number(r.GROUP_LEGACYID), t = Number(r.TUT_LEGACYID);
    if (r.TASK_ORDER == null) { imsNullOrder.push(`${g}:${t}`); desired.set(`${g}:${t}`, null); continue; }
    desired.set(`${g}:${t}`, Number(r.TASK_ORDER) + 1); // 0-based → 1-based
  }

  // 2) Current PROD GroupPathItems joined to group + tutorial legacyIds.
  const capRows = await runSql(target, `
    SELECT gpi."ID" AS "GPI_ID",
           g."LEGACYID" AS "GROUP_LEGACYID", g."SLUG" AS "GROUP_SLUG",
           t."LEGACYID" AS "TUT_LEGACYID",   t."SLUG" AS "TUT_SLUG",
           gpi."ITEMORDER" AS "ITEMORDER"
    FROM ${T}GROUPPATHITEMS gpi
    JOIN ${T}GROUPS g     ON g."ID" = gpi."GROUP_ID"
    JOIN ${T}TUTORIALS t  ON t."ID" = gpi."TUTORIAL_ID"`);
  console.log(`CAP: ${capRows.length} GroupPathItems rows read`);

  // 3) Diff per row. An update is needed when desired TASK_ORDER exists, is
  //    non-null, and differs from current ITEMORDER. Group not in IMS or
  //    IMS order null → flagged, never written.
  const updates = [];          // { gpiId, groupSlug, tutSlug, from, to }
  const flagged = [];          // { reason, groupSlug, tutSlug, ... }
  const csv = [['group_slug', 'tutorial_slug', 'group_legacyId', 'tut_legacyId',
    'current_itemOrder', 'ims_itemOrder_1based', 'action'].map(csvCell).join(',')];

  for (const r of capRows) {
    const gSlug = String(r.GROUP_SLUG || '');
    const gSlugLc = gSlug.toLowerCase();
    const key = `${Number(r.GROUP_LEGACYID)}:${Number(r.TUT_LEGACYID)}`;
    const cur = r.ITEMORDER == null ? null : Number(r.ITEMORDER);
    const want = desired.has(key) ? desired.get(key) : undefined;

    let action;
    if (skipSlugs.has(gSlugLc)) {
      // Preserved (hand-corrected). Do not write, but still record whether IMS
      // AGREES with the current value — a mismatch is worth a human glance
      // (either the hand edit diverges from IMS, or the +1 normalization is off).
      if (want != null && cur !== want) {
        action = 'skip-preserved-DIFFERS-from-ims';
        flagged.push({ reason: 'preserved-differs-from-ims', groupSlug: gSlug, tutSlug: r.TUT_SLUG, cur, want });
      } else {
        action = 'skip-preserved';
      }
    } else if (want === undefined) {
      action = 'flag-not-in-ims';
      flagged.push({ reason: 'not-in-ims', groupSlug: gSlug, tutSlug: r.TUT_SLUG });
    } else if (want === null) {
      action = 'flag-ims-null-order';
      flagged.push({ reason: 'ims-null-order', groupSlug: gSlug, tutSlug: r.TUT_SLUG });
    } else if (cur === want) {
      action = 'noop-already-correct';
    } else {
      action = 'update';
      updates.push({ gpiId: r.GPI_ID, groupSlug: gSlug, tutSlug: r.TUT_SLUG, from: cur, to: want });
    }
    csv.push([gSlug, r.TUT_SLUG, r.GROUP_LEGACYID, r.TUT_LEGACYID, cur, want, action]
      .map(csvCell).join(','));
  }

  // Summary
  const groupsTouched = new Set(updates.map(u => u.groupSlug));
  console.log(`\n▸ Rows needing update: ${updates.length}  (across ${groupsTouched.size} groups)`);
  console.log(`▸ Flagged (no write): ${flagged.length}` +
    (imsNullOrder.length ? `  [IMS null TASK_ORDER links: ${imsNullOrder.length}]` : ''));
  if (VERBOSE) {
    for (const u of updates) console.log(`   ${u.groupSlug}  ${u.tutSlug}: ${u.from} → ${u.to}`);
    for (const f of flagged) console.log(`   FLAG(${f.reason})  ${f.groupSlug}  ${f.tutSlug}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, csv.join('\n'), 'utf8');
  console.log(`▸ CSV written: ${OUT}`);

  // 4) Apply (only with --commit). Single transaction; UPDATE by row ID.
  if (COMMIT && updates.length) {
    console.log(`\n▸ Applying ${updates.length} UPDATEs in one transaction...`);
    target.setAutoCommit(false);
    try {
      for (const u of updates) {
        await runSql(target,
          `UPDATE ${T}GROUPPATHITEMS SET "ITEMORDER" = ? WHERE "ID" = ?`,
          [u.to, u.gpiId]);
      }
      await new Promise((res, rej) => target.commit(e => (e ? rej(e) : res())));
      console.log(`  ✓ Committed ${updates.length} updates.`);
    } catch (e) {
      await new Promise((res) => target.rollback(() => res()));
      console.error(`  ✗ Rolled back: ${e.message}`);
      process.exitCode = 1;
    } finally {
      target.setAutoCommit(true);
    }
  } else if (COMMIT) {
    console.log('\n▸ Nothing to update — no rows differ from IMS.');
  } else {
    console.log('\n▸ DRY RUN complete. Re-run with --commit to apply.');
  }

  source.disconnect();
  target.disconnect();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
