'use strict';

/**
 * Backfill descriptive fields + tag links onto ALREADY-MIGRATED Groups and
 * Missions.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/migrate-from-hana.js` originally selected DESCRIPTION / PRIMARY_TAG_ID
 * / EXPERIENCE_TAG_ID / AVERAGE_TTC only for Tutorials, never for Groups or
 * Missions (they share the IMS_TASK table). It also dropped every GROUP/MISSION
 * row from the tag-link step because those TASK_IDs don't resolve in
 * uuidMap.tutorials. So every migrated Group (359) and Mission (888) landed with
 * those TaskBase fields NULL and effectively no GroupTags/MissionTags.
 *
 * The migrator itself is now fixed (a future clean re-migration would populate
 * these), but PROD already holds the incomplete rows and a full re-migration is
 * heavier/riskier than a targeted backfill. This script UPDATEs the existing
 * rows in place, keyed on legacyId (stable across everything), and inserts the
 * missing tag links. It is IDEMPOTENT — safe to run repeatedly.
 *
 * The source data is fully populated (verified 2026-07-23: 359/359 groups &
 * 888/888 missions have description + primary tag + experience at source, plus
 * 654 GROUP + 696 MISSION tag links in IMS_TAG_TO_TASK).
 *
 * SAFETY
 * ------
 * - Dry-run by DEFAULT. Pass --commit to actually write.
 * - Only touches: description, primaryTag, experienceTag, averageTimeToComplete,
 *   communityMissionId (missions only), and Group/MissionTags rows. Never
 *   touches title/slug/status/published/timestamps.
 * - Only fills a column when the source has a value AND (default) the target
 *   column is currently NULL/empty. Pass --overwrite to replace non-null target
 *   values too (use when correcting a prior partial backfill).
 * - Enum normalization for experienceTag matches the migrator
 *   (normalizeExperienceTag): beginner|intermediate|advanced, else left unset.
 *
 * CREDENTIALS (same resolution as migrate-from-hana.js)
 * -----------------------------------------------------
 *   Source (IMS): IMS_HANA_CREDENTIALS json, OR IMS_DB_URL+IMS_DB_USERNAME+
 *                 IMS_DB_PASSWORD, OR cf service-key of --source-instance/-key.
 *   Target (CAP): CAP_HANA_CREDENTIALS json, OR cf service-key of
 *                 --target-instance/-key (default tutorials-hana / -key).
 *
 * USAGE
 * -----
 *   # Dry-run against PROD (reports what WOULD change; writes a CSV)
 *   IMS_HANA_CREDENTIALS="$(cat .migration-data/ims-creds.json)" \
 *   CAP_HANA_CREDENTIALS="$(cf service-key tutorials-hana tutorials-hana-key | sed -n '/{/,$p')" \
 *     node scripts/backfill-group-mission-fields.cjs
 *
 *   # Commit
 *     ... node scripts/backfill-group-mission-fields.cjs --commit
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const hdb = require('hdb');
const { v5: uuidv5 } = require('uuid');
const { NAMESPACES } = require('./lib/migration-uuid-namespaces.cjs');

const COMMIT = process.argv.includes('--commit');
const OVERWRITE = process.argv.includes('--overwrite');
const arg = (name, def) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const SOURCE_INSTANCE = arg('source-instance', 'ims-hana-qa-container');
const SOURCE_KEY = arg('source-key', 'ims-hana-qa-container-key');
const TARGET_INSTANCE = arg('target-instance', 'tutorials-hana');
const TARGET_KEY = arg('target-key', 'tutorials-hana-key');
const OUTPUT_DIR = process.env.MIGRATION_OUTPUT_DIR || '.migration-data';

// ─── credential + connection helpers (mirror migrate-from-hana.js) ───────────
function getCredentials(serviceInstance, serviceKey) {
  const raw = execFileSync('cf', ['service-key', serviceInstance, serviceKey], {
    encoding: 'utf-8',
  });
  const jsonStart = raw.indexOf('{');
  const parsed = JSON.parse(raw.slice(jsonStart));
  return parsed.credentials || parsed;
}

function resolveImsCreds() {
  if (process.env.IMS_HANA_CREDENTIALS) return JSON.parse(process.env.IMS_HANA_CREDENTIALS);
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
  return getCredentials(SOURCE_INSTANCE, SOURCE_KEY);
}

function resolveCapCreds() {
  return JSON.parse(process.env.CAP_HANA_CREDENTIALS || 'null') || getCredentials(TARGET_INSTANCE, TARGET_KEY);
}

function connect(creds, label) {
  return new Promise((resolve, reject) => {
    const user = creds.hdi_user || creds.user;
    const password = creds.hdi_password || creds.password;
    const client = hdb.createClient({
      host: creds.host,
      port: parseInt(creds.port, 10),
      user,
      password,
      useTLS: true,
      encrypt: true,
      sslValidateCertificate: false,
    });
    client.connect((err) => (err ? reject(new Error(`HANA connect to ${label} failed: ${err.message}`)) : resolve(client)));
  });
}

const run = (client, sql, params = []) =>
  new Promise((resolve, reject) => {
    if (params.length) client.prepare(sql, (e, stmt) => (e ? reject(e) : stmt.exec(params, (e2, r) => (e2 ? reject(e2) : resolve(r)))));
    else client.exec(sql, (e, r) => (e ? reject(e) : resolve(r)));
  });

// ─── pure helper (kept in sync with migrate-from-hana.js normalizeExperienceTag) ─
function normalizeExperienceTag(tagName) {
  if (tagName == null) return null;
  const v = String(tagName).trim().toLowerCase();
  if (v === 'beginner') return 'beginner';
  if (v === 'intermediate') return 'intermediate';
  if (v === 'advanced') return 'advanced';
  return null;
}

const truncStr = (v, n) => (v == null ? null : String(v).length > n ? String(v).slice(0, n) : String(v));

async function main() {
  console.log(`\n=== Backfill Group/Mission fields ${COMMIT ? '(COMMIT)' : '(DRY-RUN)'} ===`);
  console.log(`    overwrite non-null target values: ${OVERWRITE}`);

  const imsCreds = resolveImsCreds();
  const capCreds = resolveCapCreds();
  const S = `"${imsCreds.schema}"`;

  console.log(`\nSource IMS: ${imsCreds.host?.slice(0, 30)}... schema=${imsCreds.schema}`);
  const source = await connect(imsCreds, 'source');
  await run(source, `SET SCHEMA "${imsCreds.schema}"`);

  console.log(`Target CAP: ${capCreds.host?.slice(0, 30)}... schema=${capCreds.schema}`);
  const target = await connect({ ...capCreds, hdi_user: null, hdi_password: null }, 'target');
  await run(target, `SET SCHEMA "${capCreds.schema}"`);
  // Suppress @cap-js/change-tracking writes (same rationale as the migrator).
  try {
    await run(target, `SET SESSION 'ct.skip' = 'true'`);
  } catch (_) {
    /* older HANA without the session var — non-fatal */
  }

  // Tag id → name lookup (for PRIMARY_TAG_ID / EXPERIENCE_TAG_ID resolution).
  const tagMap = new Map();
  for (const t of await run(source, `SELECT "ID", "NAME" FROM ${S}."IMS_TAG"`)) tagMap.set(String(t.ID), t.NAME);
  console.log(`  tag lookup: ${tagMap.size} entries`);

  const report = [];
  const stats = {
    groups: { scanned: 0, updated: 0, skipped_missing_target: 0, tag_links: 0 },
    missions: { scanned: 0, updated: 0, skipped_missing_target: 0, tag_links: 0 },
  };

  for (const kind of ['GROUP', 'MISSION']) {
    const isMission = kind === 'MISSION';
    const targetTable = isMission ? 'COM_SAP_DEVELOPERS_IMS_MISSIONS' : 'COM_SAP_DEVELOPERS_IMS_GROUPS';
    const bucket = isMission ? stats.missions : stats.groups;

    const src = await run(
      source,
      `SELECT "ID", "DESCRIPTION", "PRIMARY_TAG_ID", "EXPERIENCE_TAG_ID", "AVERAGE_TTC"${isMission ? ', "COMMUNITY_MISSION_ID"' : ''} FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = '${kind}'`
    );

    for (const row of src) {
      bucket.scanned++;
      const legacyId = row.ID;
      // Locate the already-migrated target row by legacyId.
      const hit = await run(target, `SELECT "ID", "DESCRIPTION", "PRIMARYTAG", "EXPERIENCETAG", "AVERAGETIMETOCOMPLETE"${isMission ? ', "COMMUNITYMISSIONID"' : ''} FROM ${targetTable} WHERE "LEGACYID" = ?`, [legacyId]);
      if (!hit.length) {
        bucket.skipped_missing_target++;
        continue;
      }
      const cur = hit[0];

      const desc = row.DESCRIPTION || null;
      const primaryTag = truncStr(tagMap.get(String(row.PRIMARY_TAG_ID)), 255) || null;
      const experienceTag = normalizeExperienceTag(tagMap.get(String(row.EXPERIENCE_TAG_ID)));
      const ttc = row.AVERAGE_TTC ?? null;

      const sets = [];
      const vals = [];
      const wants = (targetCol, srcVal, curVal) => {
        if (srcVal == null) return; // nothing to write from source
        const empty = curVal == null || String(curVal).length === 0;
        if (!OVERWRITE && !empty) return; // don't clobber existing unless asked
        if (String(curVal ?? '') === String(srcVal)) return; // already equal
        sets.push(`"${targetCol}" = ?`);
        vals.push(srcVal);
      };
      wants('DESCRIPTION', desc, cur.DESCRIPTION);
      wants('PRIMARYTAG', primaryTag, cur.PRIMARYTAG);
      wants('EXPERIENCETAG', experienceTag, cur.EXPERIENCETAG);
      wants('AVERAGETIMETOCOMPLETE', ttc, cur.AVERAGETIMETOCOMPLETE);
      if (isMission) wants('COMMUNITYMISSIONID', truncStr(row.COMMUNITY_MISSION_ID, 255) || null, cur.COMMUNITYMISSIONID);

      if (sets.length) {
        report.push({ kind, legacyId, cols: sets.map((s) => s.split(' ')[0].replace(/"/g, '')).join('|') });
        if (COMMIT) {
          await run(target, `UPDATE ${targetTable} SET ${sets.join(', ')} WHERE "LEGACYID" = ?`, [...vals, legacyId]);
        }
        bucket.updated++;
      }
    }
  }

  // ─── Tag links (GroupTags / MissionTags) ───────────────────────────────────
  // Idempotent: derive the cuid ID from the composite (TASK_ID, TAG_ID) and
  // skip if a row with that ID already exists.
  const links = await run(source, `SELECT tt."TASK_ID", tt."TAG_ID", k."TASK_TYPE" FROM ${S}."IMS_TAG_TO_TASK" tt JOIN ${S}."IMS_TASK" k ON k."ID" = tt."TASK_ID" WHERE k."TASK_TYPE" IN ('GROUP','MISSION')`);
  for (const l of links) {
    const isMission = l.TASK_TYPE === 'MISSION';
    const bucket = isMission ? stats.missions : stats.groups;
    const table = isMission ? 'COM_SAP_DEVELOPERS_IMS_MISSIONTAGS' : 'COM_SAP_DEVELOPERS_IMS_GROUPTAGS';
    const parentCol = isMission ? 'MISSION_ID' : 'GROUP_ID';
    const nsKey = isMission ? NAMESPACES.missiontag : NAMESPACES.grouptag;
    const prefix = isMission ? 'mt' : 'gt';

    // Resolve parent + tag target UUIDs by legacyId (migrator uses uuidv5 too,
    // but here we look them up so we don't depend on the migrator's namespaces
    // for the parent/tag — only for the link's own ID).
    const parentHit = await run(target, `SELECT "ID" FROM ${isMission ? 'COM_SAP_DEVELOPERS_IMS_MISSIONS' : 'COM_SAP_DEVELOPERS_IMS_GROUPS'} WHERE "LEGACYID" = ?`, [l.TASK_ID]);
    const tagHit = await run(target, `SELECT "ID" FROM COM_SAP_DEVELOPERS_IMS_TAGS WHERE "LEGACYID" = ?`, [l.TAG_ID]);
    if (!parentHit.length || !tagHit.length) continue;

    const id = uuidv5(`${prefix}:${l.TASK_ID}:${l.TAG_ID}`, nsKey);
    const exists = await run(target, `SELECT "ID" FROM ${table} WHERE "ID" = ?`, [id]);
    if (exists.length) continue;

    report.push({ kind: `${l.TASK_TYPE}_TAG`, legacyId: l.TASK_ID, cols: `tag=${l.TAG_ID}` });
    if (COMMIT) {
      await run(target, `INSERT INTO ${table} ("ID", "${parentCol}", "TAG_ID") VALUES (?, ?, ?)`, [id, parentHit[0].ID, tagHit[0].ID]);
    }
    bucket.tag_links++;
  }

  // ─── report ─────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.table(stats);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = process.env.BACKFILL_STAMP || 'run';
  const csvPath = path.join(OUTPUT_DIR, `backfill-group-mission-fields.${COMMIT ? 'commit' : 'dryrun'}.${stamp}.csv`);
  fs.writeFileSync(csvPath, 'kind,legacyId,columns\n' + report.map((r) => `${r.kind},${r.legacyId},${r.cols}`).join('\n') + '\n');
  console.log(`\n${COMMIT ? 'Committed' : 'Would change'} ${report.length} changes. Detail: ${csvPath}`);
  if (!COMMIT) console.log('DRY-RUN — no writes. Re-run with --commit to apply.');

  source.disconnect();
  target.disconnect();
}

main().catch((e) => {
  console.error('BACKFILL FAILED:', e.message);
  process.exit(1);
});
