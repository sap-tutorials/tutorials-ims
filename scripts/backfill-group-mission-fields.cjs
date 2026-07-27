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
 * It also completes the Tags table: PROD's Tags only ever held the tags LINKED
 * to content at migration time, so some Groups/Missions carry a PRIMARY_TAG_ID
 * (and some links reference a TAG_ID) whose Tag row was never migrated — which
 * is why the @mandatory primaryTagRef FK couldn't resolve for ~78 published
 * rows. A tag-completion pass inserts exactly the missing content-referenced
 * tags (union of every task's PRIMARY_TAG_ID + every IMS_TAG_TO_TASK TAG_ID),
 * NOT the full ~10k IMS_TAG table, using the same deterministic UUID as the
 * migrator so existing FKs are untouched.
 *
 * The source data is fully populated (verified 2026-07-23: 359/359 groups &
 * 888/888 missions have description + primary tag + experience at source, plus
 * 654 GROUP + 696 MISSION tag links in IMS_TAG_TO_TASK).
 *
 * SAFETY
 * ------
 * - Dry-run by DEFAULT. Pass --commit to actually write.
 * - Only touches: (INSERT) missing content-referenced Tags rows; (UPDATE)
 *   description, primaryTag, primaryTagRef (the @mandatory Association to Tags
 *   the admin Groups/Missions pages display), experienceTag,
 *   averageTimeToComplete, communityMissionId (missions only), and
 *   Group/MissionTags rows. For Tutorials it touches ONLY primaryTagRef_ID
 *   (their description/primaryTag/experience come from markdown at publish
 *   time). Never touches title/slug/status/published/timestamps, and never
 *   deletes or updates an EXISTING Tag (completion is INSERT-only).
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

// A `cf service-key` JSON (or the same JSON piped through CAP_HANA_CREDENTIALS)
// nests the real connection fields under `.credentials`. A hand-written flat
// creds object (e.g. the IMS_DB_URL-derived one) does not. Unwrap either shape.
function unwrapCreds(obj) {
  return obj && obj.credentials ? obj.credentials : obj;
}

function resolveImsCreds() {
  if (process.env.IMS_HANA_CREDENTIALS) return unwrapCreds(JSON.parse(process.env.IMS_HANA_CREDENTIALS));
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
  const env = process.env.CAP_HANA_CREDENTIALS;
  if (env) return unwrapCreds(JSON.parse(env));
  return getCredentials(TARGET_INSTANCE, TARGET_KEY);
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

// Prepare once, exec many — for batched writes so we don't re-prepare per row.
const prepareStmt = (client, sql) =>
  new Promise((resolve, reject) => client.prepare(sql, (e, stmt) => (e ? reject(e) : resolve(stmt))));
const execPrepared = (stmt, params) =>
  new Promise((resolve, reject) => stmt.exec(params, (e, r) => (e ? reject(e) : resolve(r))));
const dropStmt = (stmt) => {
  try {
    stmt.drop(() => {});
  } catch (_) {
    /* fire-and-forget */
  }
};

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

  // Target Tags legacyId → target Tags.ID (UUID). The migrator sets
  // Tags.LEGACYID = source IMS_TAG.ID, so this resolves a source PRIMARY_TAG_ID
  // straight to the target association FK (primaryTagRef_ID). Built up-front
  // (not just for the tag-link step below) because the field-backfill loop
  // now also fills the @mandatory primaryTagRef association the admin
  // Groups/Missions pages display. See the primaryTagRef note in the loop.
  const tagIdByLegacy = new Map();
  for (const r of await run(target, `SELECT "LEGACYID", "ID" FROM COM_SAP_DEVELOPERS_IMS_TAGS`)) tagIdByLegacy.set(String(r.LEGACYID), r.ID);
  console.log(`  target tag id map: ${tagIdByLegacy.size} entries`);

  const report = [];
  const stats = {
    groups: { scanned: 0, updated: 0, skipped_missing_target: 0, tag_links: 0 },
    missions: { scanned: 0, updated: 0, skipped_missing_target: 0, tag_links: 0 },
    tutorials: { scanned: 0, updated: 0, skipped_missing_target: 0 },
  };

  // ─── Tag completion ─────────────────────────────────────────────────────────
  // PROD's Tags table holds only the tags that were LINKED to content at
  // migration time (verified: 0 orphan link rows). But a chunk of Groups/
  // Missions carry a PRIMARY_TAG_ID whose Tag was never migrated — and the
  // original migrator also dropped GROUP/MISSION tag links entirely, so some
  // link-referenced tags are absent too. Net effect: the @mandatory
  // primaryTagRef FK can't resolve for ~78 published rows, and some
  // Group/MissionTags links can't be attached, purely because the Tag row
  // isn't there.
  //
  // Fix: insert exactly the tags that are content-referenced but missing —
  // the union of (every task's PRIMARY_TAG_ID) ∪ (every IMS_TAG_TO_TASK
  // TAG_ID), minus what's already present. This is a surgical ~67-row add,
  // NOT a full 10k IMS_TAG re-migration (that would flood the admin Tags
  // list + value-helps with unused interest-items). Deterministic UUID
  // (uuidv5(legacyId, tag-ns)) — identical to the migrator — so any existing
  // FK that already points at a present tag is unaffected, and re-runs are
  // idempotent (missing set shrinks to ∅). `label` is intentionally left
  // null: it's populated separately by seed-tag-labels from AEM, and these
  // rows never had one. Mirrors mapTagRow in migrate-from-hana.js.
  const neededTagIds = new Set();
  for (const r of await run(source, `SELECT DISTINCT "PRIMARY_TAG_ID" AS T FROM ${S}."IMS_TASK" WHERE "PRIMARY_TAG_ID" IS NOT NULL`)) neededTagIds.add(String(r.T));
  for (const r of await run(source, `SELECT DISTINCT "TAG_ID" AS T FROM ${S}."IMS_TAG_TO_TASK"`)) neededTagIds.add(String(r.T));
  const missingTagIds = [...neededTagIds].filter((id) => !tagIdByLegacy.has(id));
  console.log(`  tag completion: ${neededTagIds.size} content-referenced, ${missingTagIds.length} missing from target`);

  if (missingTagIds.length) {
    // Fetch full source rows for the missing tags. Chunk the IN() to stay
    // under the HANA statement packet cap ([[cqn-where-in-hana-packet-cap]]).
    const missingRows = [];
    for (let i = 0; i < missingTagIds.length; i += 500) {
      const chunk = missingTagIds.slice(i, i + 500);
      const inList = chunk.map((x) => Number(x)).filter((n) => Number.isFinite(n)).join(',');
      if (!inList) continue;
      for (const r of await run(source, `SELECT "ID", "NAME", "SEMAPHORE_ID", "TITLE_PATH", "IS_ACTUAL_TAG", "IS_INTEREST_ITEM" FROM ${S}."IMS_TAG" WHERE "ID" IN (${inList})`)) {
        missingRows.push(r);
      }
    }
    for (const r of missingRows) {
      report.push({ kind: 'TAG', legacyId: r.ID, cols: `name=${r.NAME}` });
    }
    stats.tags = { needed: neededTagIds.size, missing: missingTagIds.length, inserted: 0 };

    if (COMMIT && missingRows.length) {
      const stmt = await prepareStmt(
        target,
        `INSERT INTO COM_SAP_DEVELOPERS_IMS_TAGS ("ID", "LEGACYID", "NAME", "SEMAPHOREID", "TITLEPATH", "ISACTUALTAG", "ISINTERESTITEM") VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of missingRows) {
        const id = uuidv5(String(r.ID), NAMESPACES.tag);
        await execPrepared(stmt, [
          id,
          r.ID,
          truncStr(r.NAME, 255),
          truncStr(r.SEMAPHORE_ID, 255),
          truncStr(r.TITLE_PATH, 255),
          r.IS_ACTUAL_TAG === 1 || r.IS_ACTUAL_TAG === true,
          r.IS_INTEREST_ITEM === 1 || r.IS_INTEREST_ITEM === true,
        ]);
        tagIdByLegacy.set(String(r.ID), id); // so downstream FK/link passes resolve it
        stats.tags.inserted++;
      }
      dropStmt(stmt);
    } else if (!COMMIT) {
      // DRY-RUN: still make the FK/link passes reflect what WOULD resolve, so
      // their "would update" counts are accurate post-completion.
      for (const r of missingRows) tagIdByLegacy.set(String(r.ID), uuidv5(String(r.ID), NAMESPACES.tag));
    }
  }

  // ─── Field backfill (Groups + Missions) ─────────────────────────────────────
  // Set-based, not per-row: HANA Cloud round-trips are ~100-300ms each, so a
  // per-row SELECT over 1247 rows (+ per-link lookups) stalls for minutes. We
  // fetch each target table ONCE into a legacyId→row map, diff in Node, and
  // batch the writes.
  for (const kind of ['GROUP', 'MISSION']) {
    const isMission = kind === 'MISSION';
    const targetTable = isMission ? 'COM_SAP_DEVELOPERS_IMS_MISSIONS' : 'COM_SAP_DEVELOPERS_IMS_GROUPS';
    const bucket = isMission ? stats.missions : stats.groups;

    const src = await run(
      source,
      `SELECT "ID", "DESCRIPTION", "PRIMARY_TAG_ID", "EXPERIENCE_TAG_ID", "AVERAGE_TTC"${isMission ? ', "COMMUNITY_MISSION_ID"' : ''} FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = '${kind}'`
    );

    // One bulk read of the whole target table → legacyId→current-row map.
    const curMap = new Map();
    for (const r of await run(target, `SELECT "LEGACYID", "DESCRIPTION", "PRIMARYTAG", "PRIMARYTAGREF_ID", "EXPERIENCETAG", "AVERAGETIMETOCOMPLETE"${isMission ? ', "COMMUNITYMISSIONID"' : ''} FROM ${targetTable}`)) {
      curMap.set(String(r.LEGACYID), r);
    }
    console.log(`  ${kind}: ${src.length} source rows, ${curMap.size} target rows`);

    const pending = []; // { sets:[col], vals:[v], legacyId }
    for (const row of src) {
      bucket.scanned++;
      const cur = curMap.get(String(row.ID));
      if (!cur) {
        bucket.skipped_missing_target++;
        continue;
      }

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
      wants('DESCRIPTION', row.DESCRIPTION || null, cur.DESCRIPTION);
      wants('PRIMARYTAG', truncStr(tagMap.get(String(row.PRIMARY_TAG_ID)), 255) || null, cur.PRIMARYTAG);
      // primaryTagRef_ID is the @mandatory Association to Tags the admin
      // Groups/Missions object pages + LineItems display (via
      // primaryTagRef.name / primaryTagRef_ID). Distinct from the PRIMARYTAG
      // text column above — the migrator never set the FK, so it was NULL
      // for effectively all rows (0/370 missions, 2/203 groups pre-fix) and
      // the admin "Primary Tag" column rendered blank. Resolve the FK from
      // the SAME source PRIMARY_TAG_ID via the target tag-id map.
      wants('PRIMARYTAGREF_ID', tagIdByLegacy.get(String(row.PRIMARY_TAG_ID)) || null, cur.PRIMARYTAGREF_ID);
      wants('EXPERIENCETAG', normalizeExperienceTag(tagMap.get(String(row.EXPERIENCE_TAG_ID))), cur.EXPERIENCETAG);
      wants('AVERAGETIMETOCOMPLETE', row.AVERAGE_TTC ?? null, cur.AVERAGETIMETOCOMPLETE);
      if (isMission) wants('COMMUNITYMISSIONID', truncStr(row.COMMUNITY_MISSION_ID, 255) || null, cur.COMMUNITYMISSIONID);

      if (sets.length) {
        report.push({ kind, legacyId: row.ID, cols: sets.map((s) => s.split(' ')[0].replace(/"/g, '')).join('|') });
        pending.push({ sets, vals, legacyId: row.ID });
        bucket.updated++;
      }
    }

    if (COMMIT && pending.length) {
      // Distinct SET-shapes are few (which columns are empty), but a per-row
      // prepared UPDATE is still fine here since the write set is small
      // (≤ src.length) and only fires under --commit. Group by set-shape so
      // each prepared statement is reused across its rows.
      const byShape = new Map();
      for (const p of pending) {
        const key = p.sets.join(',');
        if (!byShape.has(key)) byShape.set(key, { sets: p.sets, rows: [] });
        byShape.get(key).rows.push(p);
      }
      for (const { sets, rows } of byShape.values()) {
        const sql = `UPDATE ${targetTable} SET ${sets.join(', ')} WHERE "LEGACYID" = ?`;
        const stmt = await prepareStmt(target, sql);
        for (const p of rows) await execPrepared(stmt, [...p.vals, p.legacyId]);
        dropStmt(stmt);
      }
    }
  }

  // ─── Tutorials: primaryTagRef_ID only ───────────────────────────────────────
  // Tutorials get DESCRIPTION / PRIMARYTAG / EXPERIENCETAG from markdown at
  // publish time, so we must NOT touch those here. But primaryTagRef is the
  // same @mandatory Association to Tags that was never set by the migrator
  // (0/2893 pre-fix). It's invisible on the Tutorials admin LineItem (which
  // binds the text primaryTag), but other code / a future column may read the
  // association, and it's @mandatory. Fill the FK ONLY, from source
  // PRIMARY_TAG_ID → target Tags.ID, same as Groups/Missions above.
  {
    const targetTable = 'COM_SAP_DEVELOPERS_IMS_TUTORIALS';
    const bucket = stats.tutorials;
    const src = await run(source, `SELECT "ID", "PRIMARY_TAG_ID" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'TUTORIAL'`);
    const curMap = new Map();
    for (const r of await run(target, `SELECT "LEGACYID", "PRIMARYTAGREF_ID" FROM ${targetTable}`)) curMap.set(String(r.LEGACYID), r);
    console.log(`  TUTORIAL: ${src.length} source rows, ${curMap.size} target rows`);

    const pending = [];
    for (const row of src) {
      bucket.scanned++;
      const cur = curMap.get(String(row.ID));
      if (!cur) {
        bucket.skipped_missing_target++;
        continue;
      }
      const refId = tagIdByLegacy.get(String(row.PRIMARY_TAG_ID)) || null;
      if (refId == null) continue; // no resolvable source tag → nothing to write
      const empty = cur.PRIMARYTAGREF_ID == null || String(cur.PRIMARYTAGREF_ID).length === 0;
      if (!OVERWRITE && !empty) continue;
      if (String(cur.PRIMARYTAGREF_ID ?? '') === String(refId)) continue;
      report.push({ kind: 'TUTORIAL', legacyId: row.ID, cols: 'PRIMARYTAGREF_ID' });
      pending.push({ legacyId: row.ID, refId });
      bucket.updated++;
    }

    if (COMMIT && pending.length) {
      const stmt = await prepareStmt(target, `UPDATE ${targetTable} SET "PRIMARYTAGREF_ID" = ? WHERE "LEGACYID" = ?`);
      for (const p of pending) await execPrepared(stmt, [p.refId, p.legacyId]);
      dropStmt(stmt);
    }
  }

  // ─── Tag links (GroupTags / MissionTags) ───────────────────────────────────
  // Idempotent: derive the cuid ID from the composite (TASK_ID, TAG_ID); skip
  // if that ID already exists. Set-based — bulk-load the parent/tag legacyId→ID
  // maps and the existing-link-ID sets once, diff in Node, batch-insert.
  // (tagIdByLegacy is built up-front — see above.)
  const groupIdByLegacy = new Map();
  for (const r of await run(target, `SELECT "LEGACYID", "ID" FROM COM_SAP_DEVELOPERS_IMS_GROUPS`)) groupIdByLegacy.set(String(r.LEGACYID), r.ID);
  const missionIdByLegacy = new Map();
  for (const r of await run(target, `SELECT "LEGACYID", "ID" FROM COM_SAP_DEVELOPERS_IMS_MISSIONS`)) missionIdByLegacy.set(String(r.LEGACYID), r.ID);
  const existingGroupTagIds = new Set((await run(target, `SELECT "ID" FROM COM_SAP_DEVELOPERS_IMS_GROUPTAGS`)).map((r) => r.ID));
  const existingMissionTagIds = new Set((await run(target, `SELECT "ID" FROM COM_SAP_DEVELOPERS_IMS_MISSIONTAGS`)).map((r) => r.ID));

  const links = await run(source, `SELECT tt."TASK_ID", tt."TAG_ID", k."TASK_TYPE" FROM ${S}."IMS_TAG_TO_TASK" tt JOIN ${S}."IMS_TASK" k ON k."ID" = tt."TASK_ID" WHERE k."TASK_TYPE" IN ('GROUP','MISSION')`);
  const groupTagInserts = [];
  const missionTagInserts = [];
  for (const l of links) {
    const isMission = l.TASK_TYPE === 'MISSION';
    const bucket = isMission ? stats.missions : stats.groups;
    const parentId = (isMission ? missionIdByLegacy : groupIdByLegacy).get(String(l.TASK_ID));
    const tagId = tagIdByLegacy.get(String(l.TAG_ID));
    if (!parentId || !tagId) continue;

    const nsKey = isMission ? NAMESPACES.missiontag : NAMESPACES.grouptag;
    const prefix = isMission ? 'mt' : 'gt';
    const id = uuidv5(`${prefix}:${l.TASK_ID}:${l.TAG_ID}`, nsKey);
    const existing = isMission ? existingMissionTagIds : existingGroupTagIds;
    if (existing.has(id)) continue;
    existing.add(id); // dedupe within this run too

    report.push({ kind: `${l.TASK_TYPE}_TAG`, legacyId: l.TASK_ID, cols: `tag=${l.TAG_ID}` });
    (isMission ? missionTagInserts : groupTagInserts).push([id, parentId, tagId]);
    bucket.tag_links++;
  }

  if (COMMIT) {
    for (const [table, parentCol, inserts] of [
      ['COM_SAP_DEVELOPERS_IMS_GROUPTAGS', 'GROUP_ID', groupTagInserts],
      ['COM_SAP_DEVELOPERS_IMS_MISSIONTAGS', 'MISSION_ID', missionTagInserts],
    ]) {
      if (!inserts.length) continue;
      const stmt = await prepareStmt(target, `INSERT INTO ${table} ("ID", "${parentCol}", "TAG_ID") VALUES (?, ?, ?)`);
      for (const vals of inserts) await execPrepared(stmt, vals);
      dropStmt(stmt);
    }
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
