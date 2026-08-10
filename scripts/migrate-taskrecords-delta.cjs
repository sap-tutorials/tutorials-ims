#!/usr/bin/env node
/**
 * scripts/migrate-taskrecords-delta.cjs
 *
 * Completion-activity DELTA backfill from the frozen legacy Java IMS
 * (imsprod) into CAP PROD, covering the window between the last full
 * migration and the PROD cutover.
 *
 * ── Why this script exists ──────────────────────────────────────────────
 *
 * The last full migration ran 2026-07-22T13:14:40.859Z
 * (scripts/migrate-from-hana.js → npm run migrate:hana). Legacy IMS was
 * frozen at PROD cutover (2026-08-09) — no further writes. Completions that
 * landed in IMS between the last run and the freeze never made it to CAP.
 *
 * migrate-from-hana.js CANNOT be re-run to catch these: its taskrecords
 * path does an unconditional `DELETE FROM …TASKRECORDS` before re-inserting
 * (migrate-from-hana.js:676-682), which would WIPE every native completion
 * written directly to CAP PROD since go-live. This script never deletes.
 *
 * ── Why a windowed upsert-by-derived-UUID is provably safe ──────────────
 *
 * Migrated rows derive their PK as uuidv5(String(legacyId), NS.<type>) —
 * deterministic. Native CAP PROD rows get random cuids. A random cuid can
 * never equal a uuidv5 derivation, so anything keyed on the derived UUID
 * is structurally incapable of touching a native row. We UPDATE a row only
 * when its derived UUID already exists (an in-place IMS status transition
 * re-migrated), and INSERT otherwise. No DELETE anywhere.
 *
 * ── Entity strategy ─────────────────────────────────────────────────────
 *
 *   taskrecords           window on UPDATED_AT > SINCE, paginated by ID.
 *                         Captures brand-new rows AND in-place transitions
 *                         (STARTED→COMPLETED) since the last run.
 *   accomplishmentrecords full-set idempotent upsert-by-derived-UUID. The
 *                         source SELECT carries no reliable UPDATED_AT; the
 *                         set is small (~1.03M) and the upsert is safe.
 *   prizerecords          full-set idempotent upsert-by-derived-UUID (~41k).
 *
 * ── FK integrity ────────────────────────────────────────────────────────
 *
 * TaskRecords.user is @mandatory. A windowed completion can reference a
 * user (or event) minted in IMS after the last run — its derived UUID
 * won't exist in CAP yet. We resolve USER_ID/EVENT_ID to derived UUIDs,
 * check existence in CAP, backfill missing referenced Users first (from
 * IMS_USER), and bucket rows whose user still can't be resolved (e.g. NULL
 * SAP_ID audit cases) as `orphan-user` — skipped, logged to CSV, never
 * dropped silently. EVENT_ID is nullable, so an unresolvable event is set
 * to NULL rather than skipping the whole completion.
 *
 * ── Flags ───────────────────────────────────────────────────────────────
 *
 *   --dry-run          (default) preview + write CSV, no writes
 *   --commit           actually UPSERT rows (requires fresh <60m dry-run)
 *   --entity <list>    comma list: taskrecords,accomplishmentrecords,prizerecords
 *                      (default: all three)
 *   --since <iso>      override window floor (default: last-run timestamp)
 *   --verbose          per-bucket sample logging
 *   --initiator <str>  audit label; default ${USER}@${hostname}
 *
 * ── Env ─────────────────────────────────────────────────────────────────
 *
 *   IMS_HANA_CREDENTIALS   JSON {host,port,user,password,schema}
 *                          OR IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD
 *   CAP_HANA_CREDENTIALS   JSON service-key for target CAP HDI (PROD).
 *                          OPTIONAL — if unset, the target is auto-resolved
 *                          via `cf service-key tutorials-hana tutorials-hana-key`
 *                          off your current `cf target` (same as
 *                          migrate-from-hana.js). So, like last time, you only
 *                          need to stage the SOURCE creds; target comes from
 *                          your `cf target tutorial-system/prod`.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *
 *   IMS_HANA_CREDENTIALS=$(cat .migration-data/ims-creds.json) \
 *   CAP_HANA_CREDENTIALS=$(cat .migration-data/cap-prod-creds.json) \
 *   node scripts/migrate-taskrecords-delta.cjs --dry-run --verbose
 *
 *   ... review .migration-data/migrate-taskrecords-delta.dryrun.csv ...
 *   ... within 60 minutes ...
 *
 *   ... same env ... \
 *   node scripts/migrate-taskrecords-delta.cjs --commit \
 *     --initiator "scripts/migrate-taskrecords-delta@thomas.jung"
 *
 * Safety: --commit requires a fresh (<60 min) dry-run CSV. Idempotent —
 * re-running upserts the same rows to the same derived UUIDs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const hdb = require('hdb');
const { v5: uuidv5 } = require('uuid');
const { NAMESPACES } = require('./lib/migration-uuid-namespaces.cjs');

// ── The window floor: start of the last full migration run. Everything with
//    UPDATED_AT strictly after this may be new-or-changed since we last synced.
//    Source: .migration-data/perf-history/2026-07-22T13-14-40-859Z-unknown.json
//    metadata.startedAt. Overridable via --since for re-audits.
const LAST_RUN_ISO = '2026-07-22T13:14:40.859Z';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function argVal(f) { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; }

const DRY_RUN = has('--dry-run') || !has('--commit');
const COMMIT = has('--commit');
const VERBOSE = has('--verbose');
const SINCE = argVal('--since') || LAST_RUN_ISO;
const ENTITIES = (argVal('--entity') || 'taskrecords,accomplishmentrecords,prizerecords')
  .split(',').map((s) => s.trim()).filter(Boolean);
const INITIATOR =
  argVal('--initiator') ||
  process.env.INITIATOR ||
  `${process.env.USER || process.env.USERNAME || 'unknown'}@${os.hostname()}`;

const DRY_RUN_CSV = path.join(
  process.cwd(), '.migration-data', 'migrate-taskrecords-delta.dryrun.csv'
);
const FRESH_DRY_RUN_MS = 60 * 60 * 1000;
const PAGE_SIZE = 50_000;
const BATCH_SIZE = 5000;
const CHUNK = 5000; // IN-list chunk for existence probes (HANA param cap ~32k)

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

function deriveUuid(entityType, legacyId) {
  const ns = NAMESPACES[entityType];
  if (!ns) throw new Error(`No UUID namespace for "${entityType}"`);
  if (legacyId === null || legacyId === undefined) {
    throw new Error(`deriveUuid("${entityType}") called with null legacyId`);
  }
  return uuidv5(String(legacyId), ns);
}

function toISOTimestamp(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function truncStr(val, maxLen) {
  if (val == null) return val;
  return String(val).length > maxLen ? String(val).slice(0, maxLen) : val;
}

// Map a source IMS_TASK_RECORD row to the CAP TaskRecords column shape.
// Mirrors migrate-from-hana.js:1353 exactly so re-runs stay consistent.
// userUuidResolved / eventUuidResolved are passed in already validated
// against CAP existence (null when unresolvable). Pure — exported for tests.
function mapTaskRecordRow(row, userUuidResolved, eventUuidResolved) {
  return {
    ID: deriveUuid('taskrecord', row.ID),
    LEGACYID: row.ID,
    USER_ID: userUuidResolved,
    TASKLEGACYID: row.TASK_ID,
    TASKTYPE: row.TASK_TYPE,
    STATUS: row.STATUS,
    PROGRESS: row.PROGRESS,
    COMPLETIONTIME: row.COMPLETION_TIME,
    COMPLETIONDATE: row.STATUS === 'COMPLETED' ? toISOTimestamp(row.UPDATED_AT) : null,
    CONTENTLANGUAGE: row.CONTENT_LANGUAGE,
    SITELANGUAGE: row.SITE_LANGUAGE,
    SUBMISSIONIDSTARTED: row.SUBMISSION_ID_STARTED,
    SUBMISSIONIDCOMPLETED: row.SUBMISSION_ID_COMPLETED,
    EVENT_ID: eventUuidResolved,
    CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
    MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
    CREATEDBY: 'migration',
    MODIFIEDBY: 'migration',
  };
}

function mapAccomplishmentRecordRow(row, userUuidResolved, accUuidResolved) {
  return {
    ID: deriveUuid('accomplishmentrecord', row.ID),
    LEGACYID: row.ID,
    USER_ID: userUuidResolved,
    ACCOMPLISHMENT_ID: accUuidResolved,
    AWARDEDAT: toISOTimestamp(row.DATE),
  };
}

function mapPrizeRecordRow(row, userUuidResolved, eventUuidResolved, prizeUuidResolved) {
  return {
    ID: deriveUuid('prizerecord', row.ID),
    LEGACYID: row.ID,
    USER_ID: userUuidResolved,
    EVENT_ID: eventUuidResolved,
    PRIZE_ID: prizeUuidResolved,
    COMPLETIONPATHITEM_ID: null,
    STATUS: truncStr(row.STATUS, 50),
  };
}

// Partition mapped rows into insert vs update given the set of derived-UUID
// PKs already present in the target. Pure — exported for tests.
function partitionByExistence(mapped, existingIds) {
  const inserts = [];
  const updates = [];
  for (const m of mapped) {
    if (existingIds.has(m.ID)) updates.push(m);
    else inserts.push(m);
  }
  return { inserts, updates };
}

// ---------------------------------------------------------------------------
// HANA client helpers (same shape as sibling scripts)
// ---------------------------------------------------------------------------

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
  return new Promise((resolve, reject) => {
    if (!params || params.length === 0) {
      client.exec(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
      return;
    }
    client.prepare(sql, (perr, stmt) => {
      if (perr) return reject(perr);
      stmt.exec(params, (eerr, rows) => {
        try { stmt.drop(() => {}); } catch (_e) { /* ignore */ }
        return eerr ? reject(eerr) : resolve(rows);
      });
    });
  });
}
function prepareStmt(client, sql) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => (err ? reject(err) : resolve(stmt)));
  });
}
function runStmt(stmt, params) {
  return new Promise((resolve, reject) => {
    stmt.exec(params, (err, affected) => (err ? reject(err) : resolve(affected)));
  });
}

function resolveSourceCreds() {
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
  throw new Error('No source creds. Set IMS_HANA_CREDENTIALS or IMS_DB_URL+IMS_DB_USERNAME+IMS_DB_PASSWORD.');
}
// Target creds resolution mirrors migrate-from-hana.js so this script has the
// same ergonomics as the full migrator you ran last time: if
// CAP_HANA_CREDENTIALS isn't set, auto-resolve from a `cf service-key` off
// whatever org/space you're currently `cf target`'d at. That's why last time
// you only had to stage the SOURCE creds — the target came from your cf target.
const TARGET_INSTANCE = argVal('--target-instance') || 'tutorials-hana';
const TARGET_KEY = argVal('--target-key') || 'tutorials-hana-key';

function credsFromServiceKey(serviceInstance, serviceKey) {
  const { execFileSync } = require('node:child_process');
  const raw = execFileSync('cf', ['service-key', serviceInstance, serviceKey], { encoding: 'utf-8' });
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) throw new Error(`cf service-key ${serviceInstance} ${serviceKey} returned no JSON`);
  const parsed = JSON.parse(raw.slice(jsonStart));
  return parsed.credentials || parsed;
}

function resolveTargetCreds() {
  if (process.env.CAP_HANA_CREDENTIALS) return JSON.parse(process.env.CAP_HANA_CREDENTIALS);
  // Fallback: resolve from the currently-targeted CF org/space. Re-assert your
  // `cf target` at tutorial-system/prod immediately before running (drift risk).
  return credsFromServiceKey(TARGET_INSTANCE, TARGET_KEY);
}

// ---------------------------------------------------------------------------
// Target existence probes + write machinery
// ---------------------------------------------------------------------------

// Given candidate derived-UUID PKs, return the subset already present in the
// target table. Chunked IN-list to stay under HANA's parameter cap.
async function fetchExistingIds(target, fullTable, ids) {
  const present = new Set();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await runSql(
      target, `SELECT "ID" FROM ${fullTable} WHERE "ID" IN (${placeholders})`, slice
    );
    for (const r of rows) present.add(r.ID);
  }
  return present;
}

async function batchInsert(target, fullTable, mapped) {
  if (mapped.length === 0) return { inserted: 0, errors: 0 };
  const cols = Object.keys(mapped[0]);
  const colNames = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = await prepareStmt(target, `INSERT INTO ${fullTable} (${colNames}) VALUES (${placeholders})`);
  let inserted = 0, errors = 0;
  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const batch = mapped.slice(i, i + BATCH_SIZE);
    const paramRows = batch.map((row) => cols.map((c) => row[c] ?? null));
    try {
      await runStmt(stmt, paramRows);
      inserted += batch.length;
    } catch (_e) {
      for (const params of paramRows) {
        try { await runStmt(stmt, [params]); inserted++; }
        catch (rowErr) { errors++; if (errors <= 5) console.error(`  ✗ insert: ${(rowErr.message || '').split('\n')[0]}`); }
      }
    }
  }
  stmt.drop();
  return { inserted, errors };
}

// UPDATE every non-identity column (preserve ID/LEGACYID/CREATEDAT/CREATEDBY;
// stamp MODIFIEDBY=initiator). One statement per row — the update population is
// the small "changed in place" tail, not the bulk.
async function applyUpdates(target, fullTable, updates, preserve) {
  let updated = 0, errors = 0;
  for (const row of updates) {
    const setCols = Object.keys(row).filter((c) => !preserve.includes(c) && c !== 'MODIFIEDBY');
    if (setCols.length === 0) continue;
    const setClause = setCols.map((c) => `"${c}" = ?`).join(', ') + ', "MODIFIEDBY" = ?';
    const params = [...setCols.map((c) => row[c] ?? null), INITIATOR, row.ID];
    try {
      await runSql(target, `UPDATE ${fullTable} SET ${setClause} WHERE "ID" = ?`, params);
      updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`  ✗ update: ${(e.message || '').split('\n')[0]}`);
    }
  }
  return { updated, errors };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeDryRunCsv(rows) {
  fs.mkdirSync(path.dirname(DRY_RUN_CSV), { recursive: true });
  const header = ['entity', 'bucket', 'source_legacy_id', 'derived_uuid', 'user_legacy_id', 'note'].join(',');
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.entity, r.bucket, r.sourceLegacyId, r.derivedUuid,
      csvEscape(r.userLegacyId), csvEscape(r.note),
    ].join(','));
  }
  fs.writeFileSync(DRY_RUN_CSV, lines.join('\n') + '\n');
  return DRY_RUN_CSV;
}

// ---------------------------------------------------------------------------
// Referenced-User backfill: windowed activity can point at IMS users minted
// after the last run. Resolve each referenced USER_ID to its derived UUID; the
// ones whose derived UUID is absent from CAP need their Users row created first
// (FK is @mandatory). Users with NULL SAP_ID land too (their TaskRecords need a
// FK target) but are audited separately by the original migrator's convention.
// ---------------------------------------------------------------------------

async function backfillReferencedUsers(source, sourceSchema, target, targetTable, referencedUserLegacyIds, sampleRows, dryRun) {
  const uniq = [...new Set(referencedUserLegacyIds)].filter((v) => v != null);
  if (uniq.length === 0) return { needed: 0, created: 0, errors: 0, presentLegacy: new Set() };

  // Which derived user UUIDs already exist in CAP?
  const derivedIds = uniq.map((lid) => deriveUuid('user', lid));
  const present = await fetchExistingIds(target, targetTable, derivedIds);
  const presentLegacy = new Set(uniq.filter((lid) => present.has(deriveUuid('user', lid))));
  const missingLegacyIds = uniq.filter((lid) => !presentLegacy.has(lid));

  if (missingLegacyIds.length === 0) {
    return { needed: 0, created: 0, errors: 0, presentLegacy };
  }

  // Fetch the source rows for the missing users so we can create them.
  const created = [];
  for (let i = 0; i < missingLegacyIds.length; i += CHUNK) {
    const slice = missingLegacyIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const srcRows = await runSql(
      source,
      `SELECT "ID", "UUID", "SAP_ID" FROM "${sourceSchema}"."IMS_USER" WHERE "ID" IN (${placeholders})`,
      slice
    );
    for (const r of srcRows) {
      created.push({
        ID: deriveUuid('user', r.ID),
        LEGACYID: r.ID,
        UUID: r.UUID,
        SAPID: r.SAP_ID,
        CREATEDAT: new Date().toISOString(),
        MODIFIEDAT: new Date().toISOString(),
        CREATEDBY: 'migration',
        MODIFIEDBY: 'migration',
      });
    }
  }

  // Every source-resolvable user is now (or will be, on commit) present.
  // Add them to the present set so callers don't re-probe. A referenced
  // user legacyId with NO source IMS_USER row stays absent → orphan-user.
  for (const u of created) presentLegacy.add(u.LEGACYID);

  if (dryRun) {
    return { needed: missingLegacyIds.length, created: 0, errors: 0, wouldCreate: created.length, presentLegacy };
  }

  const res = await batchInsert(target, targetTable, created);
  return { needed: missingLegacyIds.length, created: res.inserted, errors: res.errors, presentLegacy };
}

// ---------------------------------------------------------------------------
// Per-entity delta processors
// ---------------------------------------------------------------------------

// Load a legacyId→derivedUUID existence set for a reference table (users,
// events, accomplishments, prizes) by deriving all candidate UUIDs and probing
// CAP. Returns a Set of legacyIds whose CAP row exists.
async function loadPresentLegacyIds(target, fullTable, entityType, legacyIds) {
  const uniq = [...new Set(legacyIds)].filter((v) => v != null);
  const derived = uniq.map((lid) => deriveUuid(entityType, lid));
  const presentUuids = await fetchExistingIds(target, fullTable, derived);
  const presentLegacy = new Set();
  for (const lid of uniq) if (presentUuids.has(deriveUuid(entityType, lid))) presentLegacy.add(lid);
  return presentLegacy;
}

async function processTaskRecords(ctx) {
  const { source, S, target, T, csvRows } = ctx;
  const fullTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_TASKRECORDS"`;
  const usersTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_USERS"`;
  const eventsTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_EVENTS"`;

  console.log(`\n─── taskrecords (window: UPDATED_AT > ${SINCE}) ───`);
  const rangeRows = await runSql(source,
    `SELECT MIN("ID") AS "LO", MAX("ID") AS "HI", COUNT(*) AS "C"
       FROM ${S}."IMS_TASK_RECORD" WHERE "UPDATED_AT" > ?`, [SINCE]);
  const lo0 = Number(rangeRows[0].LO ?? 0);
  const hi0 = Number(rangeRows[0].HI ?? 0);
  const total = Number(rangeRows[0].C ?? 0);
  console.log(`  ${total} source rows in window (ID ${lo0}..${hi0})`);
  if (total === 0) return { entity: 'taskrecords', inserted: 0, updated: 0, orphanUser: 0, errors: 0 };

  let inserted = 0, updated = 0, orphanUser = 0, errors = 0, seen = 0;
  for (let lo = lo0 - 1; lo < hi0; lo += PAGE_SIZE) {
    const hi = Math.min(lo + PAGE_SIZE, hi0);
    const pageRows = await runSql(source,
      `SELECT "ID","USER_ID","TASK_ID","EVENT_ID","TASK_TYPE","STATUS","COMPLETION_TIME",
              "PROGRESS","CONTENT_LANGUAGE","SITE_LANGUAGE","SUBMISSION_ID_STARTED",
              "SUBMISSION_ID_COMPLETED","CREATED_AT","UPDATED_AT"
         FROM ${S}."IMS_TASK_RECORD"
        WHERE "ID" > ${lo} AND "ID" <= ${hi} AND "UPDATED_AT" > ?`, [SINCE]);
    if (pageRows.length === 0) continue;
    seen += pageRows.length;

    // Ensure every referenced user exists in CAP first (FK is @mandatory).
    // backfillReferencedUsers returns the set of user legacyIds that exist (or
    // will, on commit) — reuse it instead of re-probing the Users table.
    const refUserLegacy = pageRows.map((r) => r.USER_ID).filter((v) => v != null);
    const bf = await backfillReferencedUsers(source, ctx.sourceSchema, target, usersTable, refUserLegacy, pageRows, DRY_RUN);
    if (bf.created) console.log(`    backfilled ${bf.created} referenced Users`);
    if (DRY_RUN && bf.wouldCreate) console.log(`    would backfill ${bf.wouldCreate} referenced Users`);
    const presentUsers = bf.presentLegacy;

    // Resolve event existence for this page (nullable FK).
    const refEventLegacy = pageRows.map((r) => r.EVENT_ID).filter((v) => v != null);
    const presentEvents = await loadPresentLegacyIds(target, eventsTable, 'event', refEventLegacy);

    const mapped = [];
    for (const r of pageRows) {
      const userOk = r.USER_ID != null && presentUsers.has(r.USER_ID);
      if (!userOk) {
        orphanUser++;
        csvRows.push({ entity: 'taskrecords', bucket: 'orphan-user', sourceLegacyId: r.ID,
          derivedUuid: deriveUuid('taskrecord', r.ID), userLegacyId: r.USER_ID, note: 'user unresolved (NULL SAP_ID or absent)' });
        continue;
      }
      const eventUuid = (r.EVENT_ID != null && presentEvents.has(r.EVENT_ID)) ? deriveUuid('event', r.EVENT_ID) : null;
      mapped.push(mapTaskRecordRow(r, deriveUuid('user', r.USER_ID), eventUuid));
    }

    const existing = await fetchExistingIds(target, fullTable, mapped.map((m) => m.ID));
    const { inserts, updates } = partitionByExistence(mapped, existing);

    for (const m of inserts) csvRows.push({ entity: 'taskrecords', bucket: 'will-insert', sourceLegacyId: m.LEGACYID, derivedUuid: m.ID, userLegacyId: '', note: m.STATUS });
    for (const m of updates) csvRows.push({ entity: 'taskrecords', bucket: 'will-update', sourceLegacyId: m.LEGACYID, derivedUuid: m.ID, userLegacyId: '', note: m.STATUS });

    if (!DRY_RUN) {
      const insRes = await batchInsert(target, fullTable, inserts);
      const updRes = await applyUpdates(target, fullTable, updates, ['ID', 'LEGACYID', 'CREATEDAT', 'CREATEDBY']);
      inserted += insRes.inserted; updated += updRes.updated; errors += insRes.errors + updRes.errors;
    } else {
      inserted += inserts.length; updated += updates.length;
    }
    process.stdout.write(`  page ${lo + 1}..${hi}: seen=${seen} ins=${inserted} upd=${updated} orphanUser=${orphanUser}\r`);
  }
  console.log('');
  return { entity: 'taskrecords', inserted, updated, orphanUser, errors };
}

async function processAccomplishmentRecords(ctx) {
  const { source, S, target, T, csvRows } = ctx;
  const fullTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS"`;
  const usersTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_USERS"`;
  const accTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS"`;

  console.log(`\n─── accomplishmentrecords (full-set idempotent upsert) ───`);
  const rows = await runSql(source, `SELECT "ID","USER_ID","ACCOMPLISHMENT_ID","DATE" FROM ${S}."IMS_ACCOMPLISHMENT_RECORD"`);
  console.log(`  ${rows.length} source rows`);
  if (rows.length === 0) return { entity: 'accomplishmentrecords', inserted: 0, updated: 0, orphanUser: 0, errors: 0 };

  const refUserLegacy = rows.map((r) => r.USER_ID).filter((v) => v != null);
  const bf = await backfillReferencedUsers(source, ctx.sourceSchema, target, usersTable, refUserLegacy, rows, DRY_RUN);
  if (bf.created) console.log(`  backfilled ${bf.created} referenced Users`);
  if (DRY_RUN && bf.wouldCreate) console.log(`  would backfill ${bf.wouldCreate} referenced Users`);

  const presentUsers = bf.presentLegacy;
  const presentAcc = await loadPresentLegacyIds(target, accTable, 'accomplishment', rows.map((r) => r.ACCOMPLISHMENT_ID));

  let inserted = 0, updated = 0, orphanUser = 0, errors = 0;
  const mapped = [];
  for (const r of rows) {
    const userOk = r.USER_ID != null && presentUsers.has(r.USER_ID);
    const accOk = r.ACCOMPLISHMENT_ID != null && presentAcc.has(r.ACCOMPLISHMENT_ID);
    if (!userOk || !accOk) {
      orphanUser++;
      csvRows.push({ entity: 'accomplishmentrecords', bucket: 'orphan-user', sourceLegacyId: r.ID,
        derivedUuid: deriveUuid('accomplishmentrecord', r.ID), userLegacyId: r.USER_ID, note: !userOk ? 'user unresolved' : 'accomplishment unresolved' });
      continue;
    }
    mapped.push(mapAccomplishmentRecordRow(r, deriveUuid('user', r.USER_ID), deriveUuid('accomplishment', r.ACCOMPLISHMENT_ID)));
  }

  const existing = await fetchExistingIds(target, fullTable, mapped.map((m) => m.ID));
  const { inserts, updates } = partitionByExistence(mapped, existing);
  for (const m of inserts) csvRows.push({ entity: 'accomplishmentrecords', bucket: 'will-insert', sourceLegacyId: m.LEGACYID, derivedUuid: m.ID, userLegacyId: '', note: '' });
  for (const m of updates) csvRows.push({ entity: 'accomplishmentrecords', bucket: 'will-update', sourceLegacyId: m.LEGACYID, derivedUuid: m.ID, userLegacyId: '', note: '' });

  if (!DRY_RUN) {
    const insRes = await batchInsert(target, fullTable, inserts);
    const updRes = await applyUpdates(target, fullTable, updates, ['ID', 'LEGACYID']);
    inserted = insRes.inserted; updated = updRes.updated; errors = insRes.errors + updRes.errors;
  } else {
    inserted = inserts.length; updated = updates.length;
  }
  console.log(`  ins=${inserted} upd=${updated} orphan=${orphanUser}`);
  return { entity: 'accomplishmentrecords', inserted, updated, orphanUser, errors };
}

async function processPrizeRecords(ctx) {
  const { source, S, target, T, csvRows } = ctx;
  const fullTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_PRIZERECORDS"`;
  const usersTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_USERS"`;
  const eventsTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_EVENTS"`;
  const prizesTable = `"${T}"."COM_SAP_DEVELOPERS_IMS_PRIZES"`;

  console.log(`\n─── prizerecords (full-set idempotent upsert) ───`);
  const rows = await runSql(source, `SELECT "ID","USER_ID","EVENT_ID","PRIZE_ID","STATUS" FROM ${S}."IMS_PRIZE_RECORD"`);
  console.log(`  ${rows.length} source rows`);
  if (rows.length === 0) return { entity: 'prizerecords', inserted: 0, updated: 0, orphanUser: 0, errors: 0 };

  const refUserLegacy = rows.map((r) => r.USER_ID).filter((v) => v != null);
  const bf = await backfillReferencedUsers(source, ctx.sourceSchema, target, usersTable, refUserLegacy, rows, DRY_RUN);
  if (bf.created) console.log(`  backfilled ${bf.created} referenced Users`);
  if (DRY_RUN && bf.wouldCreate) console.log(`  would backfill ${bf.wouldCreate} referenced Users`);

  const presentUsers = bf.presentLegacy;
  const presentPrizes = await loadPresentLegacyIds(target, prizesTable, 'prize', rows.map((r) => r.PRIZE_ID));
  const presentEvents = await loadPresentLegacyIds(target, eventsTable, 'event', rows.map((r) => r.EVENT_ID).filter((v) => v != null));

  let inserted = 0, updated = 0, orphanUser = 0, errors = 0;
  const mapped = [];
  for (const r of rows) {
    const userOk = r.USER_ID != null && presentUsers.has(r.USER_ID);
    const prizeOk = r.PRIZE_ID != null && presentPrizes.has(r.PRIZE_ID);
    if (!userOk || !prizeOk) {
      orphanUser++;
      csvRows.push({ entity: 'prizerecords', bucket: 'orphan-user', sourceLegacyId: r.ID,
        derivedUuid: deriveUuid('prizerecord', r.ID), userLegacyId: r.USER_ID, note: !userOk ? 'user unresolved' : 'prize unresolved' });
      continue;
    }
    const eventUuid = (r.EVENT_ID != null && presentEvents.has(r.EVENT_ID)) ? deriveUuid('event', r.EVENT_ID) : null;
    mapped.push(mapPrizeRecordRow(r, deriveUuid('user', r.USER_ID), eventUuid, deriveUuid('prize', r.PRIZE_ID)));
  }

  const existing = await fetchExistingIds(target, fullTable, mapped.map((m) => m.ID));
  const { inserts, updates } = partitionByExistence(mapped, existing);
  for (const m of inserts) csvRows.push({ entity: 'prizerecords', bucket: 'will-insert', sourceLegacyId: m.LEGACYID, derivedUuid: m.ID, userLegacyId: '', note: m.STATUS });
  for (const m of updates) csvRows.push({ entity: 'prizerecords', bucket: 'will-update', sourceLegacyId: m.LEGACYID, derivedUuid: m.ID, userLegacyId: '', note: m.STATUS });

  if (!DRY_RUN) {
    const insRes = await batchInsert(target, fullTable, inserts);
    const updRes = await applyUpdates(target, fullTable, updates, ['ID', 'LEGACYID']);
    inserted = insRes.inserted; updated = updRes.updated; errors = insRes.errors + updRes.errors;
  } else {
    inserted = inserts.length; updated = updates.length;
  }
  console.log(`  ins=${inserted} upd=${updated} orphan=${orphanUser}`);
  return { entity: 'prizerecords', inserted, updated, orphanUser, errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (COMMIT) {
    if (!fs.existsSync(DRY_RUN_CSV)) {
      console.error(`--commit refused: no dry-run CSV at ${DRY_RUN_CSV}. Run --dry-run first.`);
      process.exit(2);
    }
    const ageMs = Date.now() - fs.statSync(DRY_RUN_CSV).mtimeMs;
    if (ageMs > FRESH_DRY_RUN_MS) {
      console.error(`--commit refused: dry-run CSV is ${Math.round(ageMs / 60000)}m old (threshold ${FRESH_DRY_RUN_MS / 60000}m). Re-run --dry-run first.`);
      process.exit(2);
    }
  }

  const sourceCreds = resolveSourceCreds();
  const targetCreds = resolveTargetCreds();
  console.log(`Source: ${(sourceCreds.host || '').slice(0, 30)}... user=${sourceCreds.user} schema=${sourceCreds.schema}`);
  console.log(`Target: ${(targetCreds.host || '').slice(0, 30)}... schema=${targetCreds.schema}`);
  console.log(`Window floor (SINCE): ${SINCE}`);
  console.log(`Entities: ${ENTITIES.join(', ')}`);
  console.log(DRY_RUN ? '=== DRY RUN — no writes will be issued ===' : `=== COMMIT (initiator=${INITIATOR}) ===`);

  const source = await connectHana(sourceCreds);
  await runSql(source, `SET SCHEMA "${sourceCreds.schema}"`);
  console.log('  ✓ Connected to source IMS');

  const target = await connectHana(targetCreds);
  await runSql(target, `SET SCHEMA "${targetCreds.schema}"`);
  // Suppress @cap-js/change-tracking DB triggers for this session (same as
  // migrate-from-hana.js). Without it every write floods sap.changelog.Changes.
  try {
    await runSql(target, `SET SESSION 'ct.skip' = 'true'`);
    console.log('  ✓ Change-tracking suppression: ct.skip=true');
  } catch (e) {
    console.warn(`  ⚠ Could not set ct.skip (non-fatal): ${e.message}`);
  }
  console.log('  ✓ Connected to target CAP HANA');

  const ctx = {
    source, target,
    S: `"${sourceCreds.schema}"`,
    sourceSchema: sourceCreds.schema,
    T: targetCreds.schema,
    csvRows: [],
  };

  const results = [];
  if (ENTITIES.includes('taskrecords')) results.push(await processTaskRecords(ctx));
  if (ENTITIES.includes('accomplishmentrecords')) results.push(await processAccomplishmentRecords(ctx));
  if (ENTITIES.includes('prizerecords')) results.push(await processPrizeRecords(ctx));

  const csvPath = writeDryRunCsv(ctx.csvRows);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  TaskRecords delta summary                            ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  for (const r of results) {
    const verb = DRY_RUN ? 'would-insert' : 'inserted';
    const verb2 = DRY_RUN ? 'would-update' : 'updated';
    console.log(`  ${r.entity.padEnd(22)} ${verb}=${r.inserted}  ${verb2}=${r.updated}  orphanUser=${r.orphanUser}  errors=${r.errors}`);
  }
  console.log(`\n  CSV: ${csvPath}`);

  if (DRY_RUN) {
    console.log(`\n  Dry-run only. Review the CSV, then re-run within ${FRESH_DRY_RUN_MS / 60000} minutes with --commit.`);
  }

  source.end();
  target.end();
  const anyErr = results.some((r) => r.errors > 0);
  process.exit(anyErr ? 1 : 0);
}

module.exports = {
  LAST_RUN_ISO,
  deriveUuid,
  toISOTimestamp,
  truncStr,
  mapTaskRecordRow,
  mapAccomplishmentRecordRow,
  mapPrizeRecordRow,
  partitionByExistence,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exit(2);
  });
}
