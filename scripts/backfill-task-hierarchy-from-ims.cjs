/**
 * backfill-task-hierarchy-from-ims.cjs
 *
 * One-shot backfill closing two gaps in the main migrator that surfaced
 * during the 2026-06-16 cutover rehearsal:
 *
 *   1. CompletionPathItems.group_ID / tutorial_ID / mission_ID
 *      The migrator's mapper sets TASKTYPE based on the resolved UUID
 *      class but never writes the typed FK column. Result: when the
 *      navigator-catalog handler queries
 *      `WHERE taskType='GROUP' AND group_ID IS NOT NULL` it returns
 *      zero rows, so missions whose CompletionPath items reference
 *      Groups (rather than Tutorials directly) drop out of the
 *      navigator entirely. Affected 17 of 87 published missions.
 *
 *   2. GroupPathItems (entire table)
 *      The CAP-era GroupPathItems table is the join between Groups and
 *      Tutorials that the navigator's standalone-group + nested-group
 *      paths read from. The migrator skips it because IMS has no
 *      "group_path_item" table. The relationship lives in
 *      IMS_TASK_TO_PARENT where parent.task_type='GROUP' and
 *      child.task_type='TUTORIAL'. Source has 820 such links.
 *      Affected 122 of 193 published groups.
 *
 * Reuses the migrator's source-creds resolution path:
 *   IMS_HANA_CREDENTIALS env var (JSON), or
 *   IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD
 *
 * Target via CAP_HANA_CREDENTIALS env var.
 *
 * Usage:
 *   IMS_DB_URL=... IMS_DB_USERNAME=... IMS_DB_PASSWORD=... \
 *   CAP_HANA_CREDENTIALS=$(cat target-creds.json) \
 *   node scripts/backfill-task-hierarchy-from-ims.cjs [--dry-run]
 */

'use strict';

const hdb = require('hdb');
const { v5: uuidv5 } = require('uuid');
const NAMESPACES = require('./lib/migration-uuid-namespaces.cjs').NAMESPACES;

const DRY_RUN = process.argv.includes('--dry-run');

function connectHana(creds) {
  const port = parseInt(creds.port || '443', 10);
  const client = hdb.createClient({
    host: creds.host, port, user: creds.user, password: creds.password, useTLS: true
  });
  return new Promise((resolve, reject) => {
    client.connect((err) => err ? reject(err) : resolve(client));
  });
}

function runSql(client, sql) {
  // hdb's query method runs SQL; isolated in a helper so callers stay readable.
  const fn = client['exec'].bind(client);
  return new Promise((resolve, reject) =>
    fn(sql, (err, rows) => err ? reject(err) : resolve(rows)));
}

function runStmt(client, sql, params) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => {
      if (err) return reject(err);
      const fn = stmt['exec'].bind(stmt);
      fn(params, (err2, affected) => {
        stmt.drop();
        err2 ? reject(err2) : resolve(affected);
      });
    });
  });
}

function resolveSourceCreds() {
  if (process.env.IMS_HANA_CREDENTIALS) return JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  if (process.env.IMS_DB_URL) {
    const url = new URL(process.env.IMS_DB_URL.replace('jdbc:sap://', 'https://'));
    return {
      host: url.hostname, port: url.port || '443',
      user: process.env.IMS_DB_USERNAME, password: process.env.IMS_DB_PASSWORD,
      schema: url.searchParams.get('currentschema') || process.env.IMS_DB_USERNAME,
    };
  }
  throw new Error('No source credentials. Set IMS_HANA_CREDENTIALS or IMS_DB_URL+IMS_DB_USERNAME+IMS_DB_PASSWORD.');
}

function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  throw new Error('No target credentials. Set CAP_HANA_CREDENTIALS to the JSON service-key.');
}

(async function main() {
  const sourceCreds = resolveSourceCreds();
  const targetCreds = resolveTargetCreds();
  console.log(`Source: ${sourceCreds.host?.slice(0, 30)}... user=${sourceCreds.user}`);
  console.log(`Target: ${targetCreds.host?.slice(0, 30)}... schema=${targetCreds.schema}`);
  if (DRY_RUN) console.log('=== DRY RUN — no writes ===');

  const source = await connectHana(sourceCreds);
  await runSql(source, `SET SCHEMA "${sourceCreds.schema}"`);
  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);
  console.log('  ✓ Connected');

  // ─── Pass 1: backfill CompletionPathItems FK columns ───────────────────────
  console.log('\n▸ Pass 1: backfill CompletionPathItems.group_ID / tutorial_ID / mission_ID');

  const tutByLegacy = new Map();
  for (const r of await runSql(target, 'SELECT ID, LEGACYID FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS')) {
    tutByLegacy.set(r.LEGACYID, r.ID);
  }
  const groupByLegacy = new Map();
  for (const r of await runSql(target, 'SELECT ID, LEGACYID FROM COM_SAP_DEVELOPERS_IMS_GROUPS')) {
    groupByLegacy.set(r.LEGACYID, r.ID);
  }
  const missionByLegacy = new Map();
  for (const r of await runSql(target, 'SELECT ID, LEGACYID FROM COM_SAP_DEVELOPERS_IMS_MISSIONS')) {
    missionByLegacy.set(r.LEGACYID, r.ID);
  }
  console.log(`  Tutorials: ${tutByLegacy.size}  Groups: ${groupByLegacy.size}  Missions: ${missionByLegacy.size}`);

  // Note: CPI schema only has TUTORIAL_ID and GROUP_ID columns (no MISSION_ID).
  // taskType='MISSION' rows aren't expected here per current data and the schema.
  const cpiRows = await runSql(target,
    'SELECT ID, TASKLEGACYID, TASKTYPE, TUTORIAL_ID, GROUP_ID FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS');
  console.log(`  ${cpiRows.length} CompletionPathItems rows`);

  let p1Tut = 0, p1Group = 0, p1Skipped = 0;
  for (const row of cpiRows) {
    let targetCol = null, targetUuid = null;
    if (row.TASKTYPE === 'TUTORIAL' && !row.TUTORIAL_ID) {
      targetUuid = tutByLegacy.get(row.TASKLEGACYID);
      if (targetUuid) { targetCol = 'TUTORIAL_ID'; p1Tut++; }
    } else if (row.TASKTYPE === 'GROUP' && !row.GROUP_ID) {
      targetUuid = groupByLegacy.get(row.TASKLEGACYID);
      if (targetUuid) { targetCol = 'GROUP_ID'; p1Group++; }
    } else {
      p1Skipped++;
      continue;
    }
    if (!targetCol) { p1Skipped++; continue; }
    if (!DRY_RUN) {
      await runStmt(target,
        `UPDATE COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS SET ${targetCol} = ? WHERE ID = ?`,
        [targetUuid, row.ID]);
    }
  }
  console.log(`  ${DRY_RUN ? 'Would set' : 'Set'} TUTORIAL_ID on ${p1Tut} rows, GROUP_ID on ${p1Group} rows. Skipped ${p1Skipped} (already set or unresolvable).`);

  // ─── Pass 2: populate GroupPathItems from IMS_TASK_TO_PARENT ───────────────
  console.log('\n▸ Pass 2: populate GroupPathItems from IMS_TASK_TO_PARENT (group→tutorial)');

  const linkRows = await runSql(source, `
    SELECT
      ttp.PARENT_TASK_ID AS GROUP_LEGACYID,
      ttp.CHILD_TASK_ID  AS TUT_LEGACYID,
      ROW_NUMBER() OVER (PARTITION BY ttp.PARENT_TASK_ID ORDER BY ttp.CHILD_TASK_ID) AS ITEM_ORDER
    FROM IMS_TASK_TO_PARENT ttp
    INNER JOIN IMS_TASK p ON p.ID = ttp.PARENT_TASK_ID
    INNER JOIN IMS_TASK c ON c.ID = ttp.CHILD_TASK_ID
    WHERE p.TASK_TYPE = 'GROUP' AND c.TASK_TYPE = 'TUTORIAL'
    ORDER BY ttp.PARENT_TASK_ID, ttp.CHILD_TASK_ID
  `);
  console.log(`  Read ${linkRows.length} group→tutorial links from IMS source`);

  if (!DRY_RUN) {
    await runSql(target, 'DELETE FROM COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS');
    console.log('  ✓ Cleared existing GroupPathItems');
  }

  // Re-use the completionpathitem UUID namespace; legacyIds from the two
  // source tables (IMS_COMPLETION_PATH_TO_TASK vs IMS_TASK_TO_PARENT) don't
  // overlap, and the input keys are namespaced with a "gpi:" prefix.
  const NS = NAMESPACES.completionpathitem;

  let p2Inserted = 0, p2Missing = 0;
  for (const row of linkRows) {
    const groupUuid = groupByLegacy.get(row.GROUP_LEGACYID);
    const tutUuid = tutByLegacy.get(row.TUT_LEGACYID);
    if (!groupUuid || !tutUuid) { p2Missing++; continue; }
    const id = uuidv5(`gpi:${row.GROUP_LEGACYID}:${row.TUT_LEGACYID}`, NS);
    if (!DRY_RUN) {
      await runStmt(target, `
        INSERT INTO COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS
          (ID, GROUP_ID, TUTORIAL_ID, ITEMORDER)
        VALUES (?, ?, ?, ?)
      `, [id, groupUuid, tutUuid, row.ITEM_ORDER]);
    }
    p2Inserted++;
  }
  console.log(`  ${DRY_RUN ? 'Would insert' : 'Inserted'} ${p2Inserted} GroupPathItems rows. Skipped ${p2Missing} (group or tutorial not in target).`);

  // ─── Verify ────────────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    const verify = await runSql(target, `
      SELECT
        (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS WHERE TASKTYPE='GROUP' AND GROUP_ID IS NOT NULL) AS CPI_GROUPS,
        (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS WHERE TASKTYPE='TUTORIAL' AND TUTORIAL_ID IS NOT NULL) AS CPI_TUTS,
        (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS) AS GPI_TOTAL
      FROM SYS.DUMMY
    `);
    console.log('\n▸ AFTER:', JSON.stringify(verify));
  }

  source.end();
  target.end();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
