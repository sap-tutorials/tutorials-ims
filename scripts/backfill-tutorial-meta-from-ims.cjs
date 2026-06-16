/**
 * backfill-tutorial-meta-from-ims.cjs
 *
 * One-shot backfill: pulls TutorialMeta owner emails and reviewed flags
 * from IMS prod (IMS_TUTORIAL_META + IMS_TUTORIAL_AUTHOR), maps each
 * source row's TUTORIAL_ID (BIGINT legacy) to its deterministic Tutorial
 * UUID via the same namespace the main migrator uses, and UPDATEs the
 * DEV target's COM_SAP_DEVELOPERS_IMS_TUTORIALMETA rows in place.
 *
 * Surfaced during 2026-06-16 cutover rehearsal: the main migrator
 * (scripts/migrate-from-hana.js) does NOT include TutorialMeta because
 * it's a CAP-era entity. But the OWNER and REVIEWEDDATE columns DO
 * matter for Tutorial Health, and IMS prod has the source data.
 *
 * Reuses the migrator's source-creds resolution path:
 *   1. IMS_HANA_CREDENTIALS env var (JSON string)
 *   2. IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD env vars
 *
 * Target creds via CAP_HANA_CREDENTIALS env var (JSON string).
 *
 * Mapping rules:
 *   - source.OWNER_ID JOIN to IMS_TUTORIAL_AUTHOR.EMAIL maps to DEV.OWNER (NVARCHAR)
 *     If the joined author has no email (IMS source has 136/385 authors with
 *     null EMAIL), DEV.OWNER stays whatever it was (preserves any manual
 *     curation done via the admin UI).
 *   - source.IS_REVIEWED = 1 maps to DEV.REVIEWEDDATE = source.UPDATED_AT
 *     IMS doesn't carry a reviewed-DATE, only a boolean. The closest
 *     semantic match is the meta row's own UPDATED_AT.
 *     IS_REVIEWED = 0 leaves DEV.REVIEWEDDATE NULL (no overwrite).
 *   - source.NOTIFICATION_NUMBER maps to DEV.NOTIFICATIONNUMBER
 *   - source.NOTIFICATION_DATE maps to DEV.LASTNOTIFICATIONDATE
 *
 * Deterministic UUID derivation matches the main migrator:
 *   targetUuid = uuidv5(String(sourceTutorialLegacyId), NAMESPACES.tutorial)
 *
 * Idempotent: re-running over the same source set produces the same
 * UPDATE outcomes. Safe to re-run after a re-migration.
 *
 * Usage:
 *   IMS_DB_URL="..." IMS_DB_USERNAME="..." IMS_DB_PASSWORD="..." \
 *   CAP_HANA_CREDENTIALS="$(cat artifacts/target-creds.json)" \
 *   node scripts/backfill-tutorial-meta-from-ims.cjs [--dry-run]
 */

'use strict';

const hdb = require('hdb');
const { v5: uuidv5 } = require('uuid');
const NAMESPACES = require('./lib/migration-uuid-namespaces.cjs').NAMESPACES;

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

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
  return new Promise((resolve, reject) => {
    client.exec(sql, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function prepareStmt(client, sql) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => err ? reject(err) : resolve(stmt));
  });
}

function runStmt(stmt, params) {
  return new Promise((resolve, reject) => {
    stmt.exec(params, (err, affected) => err ? reject(err) : resolve(affected));
  });
}

function resolveSourceCreds() {
  if (process.env.IMS_HANA_CREDENTIALS) {
    return JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  }
  if (process.env.IMS_DB_URL) {
    const url = new URL(process.env.IMS_DB_URL.replace('jdbc:sap://', 'https://'));
    return {
      host: url.hostname,
      port: url.port || '443',
      user: process.env.IMS_DB_USERNAME,
      password: process.env.IMS_DB_PASSWORD,
      schema: url.searchParams.get('currentschema') || process.env.IMS_DB_USERNAME,
    };
  }
  throw new Error('No source credentials. Set IMS_HANA_CREDENTIALS or IMS_DB_URL+IMS_DB_USERNAME+IMS_DB_PASSWORD.');
}

function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) {
    return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  }
  throw new Error('No target credentials. Set CAP_HANA_CREDENTIALS to the JSON service-key.');
}

function tutorialUuid(legacyId) {
  return uuidv5(String(legacyId), NAMESPACES.tutorial);
}

(async function main() {
  const sourceCreds = resolveSourceCreds();
  const targetCreds = resolveTargetCreds();

  console.log(`Source: ${sourceCreds.host?.slice(0, 30)}... user=${sourceCreds.user}`);
  console.log(`Target: ${targetCreds.host?.slice(0, 30)}... schema=${targetCreds.schema}`);
  if (DRY_RUN) console.log('=== DRY RUN — no UPDATEs will be issued ===');

  const source = await connectHana(sourceCreds);
  await runSql(source, `SET SCHEMA "${sourceCreds.schema}"`);
  console.log('  ✓ Connected to source');

  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);
  console.log('  ✓ Connected to target');

  // Pull IMS rows joined to authors. EMAIL may be null (136/385 authors).
  const sourceRows = await runSql(source, `
    SELECT
      TM.TUTORIAL_ID  AS TUT_LEGACY_ID,
      A.EMAIL         AS OWNER_EMAIL,
      TM.IS_REVIEWED  AS IS_REVIEWED,
      TM.UPDATED_AT   AS UPDATED_AT,
      TM.NOTIFICATION_NUMBER AS NOTIF_NUM,
      TM.NOTIFICATION_DATE   AS NOTIF_DATE
    FROM IMS_TUTORIAL_META TM
    JOIN IMS_TUTORIAL_AUTHOR A ON TM.OWNER_ID = A.ID
  `);
  console.log(`  Read ${sourceRows.length} TutorialMeta rows from IMS source`);
  const withEmail = sourceRows.filter(r => r.OWNER_EMAIL).length;
  const reviewedCount = sourceRows.filter(r => r.IS_REVIEWED === 1).length;
  console.log(`  - With email:  ${withEmail}`);
  console.log(`  - Reviewed:    ${reviewedCount}`);

  let updatedOwner = 0, updatedReviewed = 0, updatedNotif = 0, missing = 0, errCount = 0;
  let stmt = null;
  if (!DRY_RUN) {
    stmt = await prepareStmt(target,
      `UPDATE COM_SAP_DEVELOPERS_IMS_TUTORIALMETA
          SET OWNER                = COALESCE(?, OWNER),
              REVIEWEDDATE         = COALESCE(?, REVIEWEDDATE),
              NOTIFICATIONNUMBER   = COALESCE(?, NOTIFICATIONNUMBER),
              LASTNOTIFICATIONDATE = COALESCE(?, LASTNOTIFICATIONDATE),
              MODIFIEDAT           = CURRENT_TIMESTAMP,
              MODIFIEDBY           = 'backfill-script'
        WHERE TUTORIAL_ID = ?`);
  }

  for (const row of sourceRows) {
    const targetTutorialUuid = tutorialUuid(row.TUT_LEGACY_ID);
    const ownerEmail = row.OWNER_EMAIL || null;
    const reviewedDate = (row.IS_REVIEWED === 1 && row.UPDATED_AT) ? row.UPDATED_AT : null;
    const notifNum = (row.NOTIF_NUM != null && row.NOTIF_NUM !== 0) ? row.NOTIF_NUM : null;
    const notifDate = row.NOTIF_DATE || null;

    if (!ownerEmail && !reviewedDate && notifNum == null && notifDate == null) {
      missing++;
      continue;
    }

    if (DRY_RUN) {
      if (VERBOSE) console.log(`  [dry-run] tut=${row.TUT_LEGACY_ID} owner=${ownerEmail||'-'} reviewed=${reviewedDate?'Y':'N'}`);
      if (ownerEmail) updatedOwner++;
      if (reviewedDate) updatedReviewed++;
      if (notifNum != null || notifDate) updatedNotif++;
      continue;
    }

    try {
      const params = [ownerEmail, reviewedDate, notifNum, notifDate, targetTutorialUuid];
      const affected = await runStmt(stmt, params);
      if (affected > 0) {
        if (ownerEmail) updatedOwner++;
        if (reviewedDate) updatedReviewed++;
        if (notifNum != null || notifDate) updatedNotif++;
      } else {
        missing++;
      }
    } catch (e) {
      errCount++;
      if (errCount <= 5) console.error(`  ✗ ${row.TUT_LEGACY_ID}: ${e.message.split('\n')[0]}`);
    }
  }

  if (stmt) stmt.drop();

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Backfill Summary                                    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Source rows read:                    ${sourceRows.length}`);
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} owner email:        ${updatedOwner}`);
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} reviewedDate:       ${updatedReviewed}`);
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} notification stats: ${updatedNotif}`);
  console.log(`  Skipped (no data or no target row):  ${missing}`);
  console.log(`  Errors:                              ${errCount}`);

  source.end();
  target.end();
  process.exit(errCount > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
