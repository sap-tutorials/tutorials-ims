#!/usr/bin/env node
/**
 * Direct HANA-to-HANA migration from Java IMS HDI container to CAP HDI container.
 * Supports cross-instance migration (e.g. QA HANA → DEV HANA).
 *
 * Usage:
 *   node scripts/migrate-from-hana.js [--dry-run] [--discover] [--entity=tutorials,users,...]
 *
 * Source (IMS) credentials resolution (first match wins):
 *   1. IMS_HANA_CREDENTIALS env var (JSON string with host, port, user, password, schema)
 *   2. IMS_DB_URL + IMS_DB_USERNAME + IMS_DB_PASSWORD env vars (from cf env <app>)
 *   3. --source-instance=<name> --source-key=<name> (cf service-key for HDI container)
 *
 * Target (CAP) credentials resolution:
 *   1. CAP_HANA_CREDENTIALS env var (JSON string)
 *   2. --target-instance=<name> --target-key=<name> (cf service-key lookup)
 *   3. Default: tutorials-hana-dev / tutorials-hana-dev-key (in DEV space)
 *
 * Modes:
 *   --discover     List tables in source schema (no migration)
 *   --dry-run      Show what would be migrated without writing
 *   --source-only  Only connect to source (skip target)
 */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'node:url';
import hdb from 'hdb';

// Issue #337: deterministic UUIDs derived from (entity_namespace, legacyId).
// Re-running the migrator produces the same UUIDs for the same source rows,
// so CAP-era tables that reference these entities by FK (TutorialMeta,
// TutorialEmbedding, etc.) stay linked across re-runs.
const _require = createRequire(import.meta.url);
const { v5: uuidv5 } = _require('uuid');
const { NAMESPACES } = _require('./lib/migration-uuid-namespaces.cjs');

function deriveUuid(entityType, legacyId) {
  const ns = NAMESPACES[entityType];
  if (!ns) throw new Error(`No UUID namespace registered for entity type "${entityType}". Add it to scripts/lib/migration-uuid-namespaces.cjs.`);
  if (legacyId === null || legacyId === undefined) throw new Error(`deriveUuid("${entityType}", ?) called with null/undefined legacyId`);
  return uuidv5(String(legacyId), ns);
}

const DRY_RUN = process.argv.includes('--dry-run');
const DISCOVER = process.argv.includes('--discover');
const SOURCE_ONLY = process.argv.includes('--source-only');
const LIST_ENTITIES = process.argv.includes('--list-entities');
const ENTITY_FILTER = process.argv.find(a => a.startsWith('--entity='))?.split('=')[1]?.split(',') || null;

const SOURCE_INSTANCE = process.argv.find(a => a.startsWith('--source-instance='))?.split('=')[1] || 'ims-hana-qa-container';
const SOURCE_KEY = process.argv.find(a => a.startsWith('--source-key='))?.split('=')[1] || 'ims-hana-qa-container-key';
const TARGET_INSTANCE = process.argv.find(a => a.startsWith('--target-instance='))?.split('=')[1] || 'tutorials-hana';
const TARGET_KEY = process.argv.find(a => a.startsWith('--target-key='))?.split('=')[1] || 'tutorials-hana-key';

// ─── Connection helpers ───────────────────────────────────────────────────────

function getCredentials(serviceInstance, serviceKey) {
  try {
    const raw = execFileSync('cf', ['service-key', serviceInstance, serviceKey], { encoding: 'utf-8' });
    const jsonStart = raw.indexOf('{');
    return JSON.parse(raw.slice(jsonStart)).credentials || JSON.parse(raw.slice(jsonStart));
  } catch (e) {
    throw new Error(`Failed to get credentials for ${serviceInstance}/${serviceKey}: ${e.message}`);
  }
}

function connect(creds, label) {
  return new Promise((resolve, reject) => {
    const user = creds.hdi_user || creds.user;
    const password = creds.hdi_password || creds.password;
    console.log(`  Connecting to ${label} as ${user.slice(-20)}...`);
    const client = hdb.createClient({
      host: creds.host,
      port: parseInt(creds.port),
      user: user,
      password: password,
      useTLS: true,
      encrypt: true,
      sslValidateCertificate: false,
    });
    client.connect(err => {
      if (err) reject(new Error(`HANA connect to ${label} failed: ${err.message}`));
      else resolve(client);
    });
  });
}

export function query(client, sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!params || params.length === 0) {
      // No parameters → hdb's exec(sql, options, cb) auto-fetches result rows.
      client.exec(sql, (err, rows) => {
        if (err) reject(new Error(`SQL error: ${err.message}\n  SQL: ${sql}`));
        else resolve(rows);
      });
      return;
    }
    // Parameterized → must prepare + statement.exec(params, cb). The client
    // .exec(command, options, cb) signature treats the middle arg as OPTIONS,
    // not as bound parameters — passing an array there silently leaves all `?`
    // placeholders unbound (HANA then errors with "unbound parameter : 1 of N").
    // Discovered 2026-06-20 mid re-migration session — the upsertOnSlug code
    // path in PR #468 was the first real-mode caller of query() with params.
    client.prepare(sql, (prepErr, stmt) => {
      if (prepErr) {
        reject(new Error(`SQL error: ${prepErr.message}\n  SQL: ${sql}`));
        return;
      }
      stmt.exec(params, (execErr, rows) => {
        // hdb's stmt.drop() releases server-side state; safe to fire-and-forget.
        try { stmt.drop(() => {}); } catch (_e) { /* ignore */ }
        if (execErr) reject(new Error(`SQL error: ${execErr.message}\n  SQL: ${sql}`));
        else resolve(rows);
      });
    });
  });
}

export function execStmt(client, sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!params || params.length === 0) {
      client.exec(sql, (err, result) => {
        if (err) reject(new Error(`SQL error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`));
        else resolve(result);
      });
      return;
    }
    client.prepare(sql, (prepErr, stmt) => {
      if (prepErr) {
        reject(new Error(`SQL error: ${prepErr.message}\n  SQL: ${sql.slice(0, 200)}`));
        return;
      }
      stmt.exec(params, (execErr, result) => {
        try { stmt.drop(() => {}); } catch (_e) { /* ignore */ }
        if (execErr) reject(new Error(`SQL error: ${execErr.message}\n  SQL: ${sql.slice(0, 200)}`));
        else resolve(result);
      });
    });
  });
}

// ─── Timestamp formatting ─────────────────────────────────────────────────────

function toISOTimestamp(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function truncStr(val, maxLen) {
  if (!val) return val;
  return String(val).length > maxLen ? String(val).slice(0, maxLen) : val;
}

// ─── Migration logic ──────────────────────────────────────────────────────────

const BATCH_SIZE = 5000;

function prepare(client, sql) {
  return new Promise((resolve, reject) => {
    client.prepare(sql, (err, stmt) => {
      if (err) reject(new Error(`Prepare error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`));
      else resolve(stmt);
    });
  });
}

function execBatch(stmt, rows) {
  return new Promise((resolve, reject) => {
    stmt.exec(rows, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Aggregate per-tutorial step counts from a stepParentMap. Pure helper —
// exported for unit tests. Input shape: Map<childTaskId, { parentId, order }>
// from IMS_TASK_TO_PARENT. Output: Map<tutorialId, count>. Rows with null
// parentId are skipped (orphan steps don't contribute to any tutorial's
// rollup denominator). Issue #466 — Tutorials.stepCount was NULL for
// 1391/~1397 tutorials in the 2026-06-20 cutover audit because the migrator
// never populated it.
export function computeTutorialStepCount(stepParentMap) {
  const counts = new Map();
  for (const { parentId } of stepParentMap.values()) {
    if (parentId == null) continue;
    counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return counts;
}

// Java IMS uses TASK_STATUS=NULL to mean "active" and 'DELETED' for soft-deleted.
// CAP catalog filters expect 'ACTIVE' or 'DELETED' literals — see catalog-data
// .js:137 which requires strict status='ACTIVE'. Without normalization at
// migration time, /build/catalog returns 0 missions/groups (issue #477).
// Pure helper — exported for unit tests.
export function normalizeStatus(rawStatus) {
  if (rawStatus == null || rawStatus === '') return 'ACTIVE';
  return String(rawStatus).toUpperCase();
}

// Java IMS has no `published` column. CAP schema declares published : Boolean
// with implicit default false. /build/catalog's first query is
// SELECT.from(Missions).where({ published: true }), so unset = invisible.
// Derive from source TASK_STATUS: any non-DELETED row is published.
// Pure helper — exported for unit tests.
export function derivePublished(rawStatus) {
  return normalizeStatus(rawStatus) !== 'DELETED';
}

// Derive a slug for a CompletionPath from its title (Java IMS doesn't store
// one — slug is a CAP-side concept). Returns kebab-cased title with a
// `path-${legacyId}` fallback for missing/empty input. Collision avoidance
// via the caller-supplied `seen` Set: re-using the same Set across calls in
// one migration pass guarantees uniqueness within the pass. Pure helper —
// exported for unit tests. Issue #466 — CompletionPaths.slug was NULL for
// 311 rows in the 2026-06-20 cutover audit, breaking /build/catalog.
export function deriveCompletionPathSlug(name, legacyId, seen) {
  const base = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 240);
  let candidate = base || `path-${legacyId}`;
  let i = 1;
  while (seen.has(candidate)) {
    candidate = `${base || 'path'}-${legacyId}-${i++}`;
  }
  seen.add(candidate);
  return candidate;
}

// Dedupe Tutorials.slug across an in-pass `seen` Set. Java IMS sometimes has
// multiple IMS_TASK rows mapping to the same source markdown URL — most
// commonly an ACTIVE row + a DELETED archive row pointing at the same
// GitHub path. With @assert.unique.slug enforced (PR #467), both rows can't
// coexist; the later-seen one needs a suffix. Suffixing on legacyId makes
// the choice deterministic across re-runs (uuid v5 from the migrator's
// deriveUuid uses legacyId, so the suffixed slug stays stable too).
//
// The caller MUST sort source rows by `(STATUS != 'DELETED', UPDATED_AT DESC)`
// so the surviving "winner" slug is the most recent ACTIVE row. The DELETED
// or older row gets the suffixed slug.
//
// Issue #473.
export function dedupeTutorialSlug(rawSlug, legacyId, seen) {
  if (!rawSlug) {
    // Empty/null source: emit `tutorial-${legacyId}` and let the caller's
    // mapRow placeholder branch handle it. We still record it in `seen`
    // for collision tracking.
    const candidate = `tutorial-${legacyId}`;
    if (seen.has(candidate)) {
      // Extremely unlikely but possible if legacyId collides — mostly a
      // belt-and-braces guard. Suffix with a counter.
      let i = 1;
      while (seen.has(`${candidate}-${i}`)) i++;
      const final = `${candidate}-${i}`;
      seen.add(final);
      return final;
    }
    seen.add(candidate);
    return candidate;
  }
  if (!seen.has(rawSlug)) {
    seen.add(rawSlug);
    return rawSlug;
  }
  // Collision: suffix with legacyId for stability.
  let candidate = `${rawSlug}-${legacyId}`;
  let i = 1;
  while (seen.has(candidate)) {
    candidate = `${rawSlug}-${legacyId}-${i++}`;
  }
  seen.add(candidate);
  return candidate;
}

// Audit users with NULL SAP_ID. They land in the DB so their TaskRecords
// have a FK target, but they're invisible to /api/getProgress (developer-
// service.js looks up by sapId; missing → returns 0/0/0). The 2026-06-20
// cutover audit found 472 such users. We don't drop them (FK survival), but
// we DO write their legacyIds out so post-migration ops can reconcile or
// hard-delete. Issue #466. Pure-ish helper — exported for tests; the `fs`
// implementation is injected so tests can verify without writing to disk.
export async function auditNullSapidUsers(source, sourceSchema, queryFn, fsImpl = { mkdirSync, writeFileSync }, cwd = process.cwd()) {
  try {
    const rows = await queryFn(source, `SELECT "ID", "UUID" FROM "${sourceSchema}"."IMS_USER" WHERE "SAP_ID" IS NULL`);
    if (!rows || rows.length === 0) return { count: 0, path: null };
    const path = join(cwd, '.migration-data', 'null-sapid-users.json');
    fsImpl.mkdirSync(dirname(path), { recursive: true });
    fsImpl.writeFileSync(path, JSON.stringify(rows, null, 2));
    return { count: rows.length, path };
  } catch (e) {
    return { count: 0, path: null, error: e.message };
  }
}

// Partition mapped rows by whether their lowercased SLUG already exists in
// the target table. Pure function — exported for unit tests. Rows without a
// SLUG field bypass the partition (they don't participate in slug-based
// matching) and are returned in `passthrough` so the caller can decide what
// to do with them.
//
// Mirrors the publish-side LOWER(slug)=? upsert in
// srv/lib/content-publish-session.js so a re-run of the cutover migrator no
// longer creates duplicates on top of already-published rows. Issue #338.
// #385 PR-2: extracted for vitest reach-through. Source schema verified against
// Tag.java 2026-06-21 — semaphore_id is NOT NULL in source but CAP stays
// nullable; is_actual_tag is primitive bool (never null); is_interest_item is
// Boolean boxed (nullable). HANA's hdb driver returns booleans as 1/0
// integers — accept both 1 and true explicitly.
export function mapTagRow(row, tagUuid) {
  return {
    ID: tagUuid,
    LEGACYID: row.ID,
    NAME: truncStr(row.NAME, 255),
    SEMAPHOREID: truncStr(row.SEMAPHORE_ID, 255),
    ISACTUALTAG:    row.IS_ACTUAL_TAG === 1 || row.IS_ACTUAL_TAG === true,
    ISINTERESTITEM: row.IS_INTEREST_ITEM === 1 || row.IS_INTEREST_ITEM === true,
  };
}

// #385 PR-2: extracted for vitest reach-through. IMS_TUTORIAL_AUTHOR is a
// flat global table — no per-tutorial FK on the Java entity. Migrated rows
// land with TUTORIAL_ID = NULL; CAP-side TutorialContributors.tutorial is
// nullable, so flat-global rows co-exist with future per-tutorial records.
export function mapTutorialContributorRow(row) {
  return {
    ID: deriveUuid('tutorialcontributor', row.ID),
    LEGACYID: row.ID,
    TUTORIAL_ID: null,
    NAME:  truncStr(row.NAME, 255),
    EMAIL: truncStr(row.EMAIL, 255),
    ROLE:  null,
  };
}

// #385 PR-2: extracted for vitest reach-through. Source IMS_TUTORIAL_REPOSITORY
// = (id, repository_name UNIQUE, repository_owner_id → IMS_TUTORIAL_AUTHOR.id).
// PR-1 reshape made TutorialRepositories.repositoryOwner an Association to
// TutorialContributors — `contributorMap` resolves the FK at map time so we
// don't need a runtime JOIN. Orphan FKs (source row points at a missing
// contributor) become NULL — matches the spec's chain-query NULL-safe path.
export function mapTutorialRepositoryRow(row, contributorMap) {
  return {
    ID: deriveUuid('tutorialrepository', row.ID),
    LEGACYID: row.ID,
    NAME: truncStr(row.REPOSITORY_NAME, 255),
    REPOSITORYOWNER_ID: row.REPOSITORY_OWNER_ID
      ? (contributorMap.get(row.REPOSITORY_OWNER_ID) || null)
      : null,
  };
}

export function partitionBySlug(mapped, existingMap) {
  const inserts = [];
  const updates = [];
  const passthrough = [];
  for (const row of mapped) {
    if (row.SLUG === undefined || row.SLUG === null || row.SLUG === '') {
      passthrough.push(row);
      continue;
    }
    const key = String(row.SLUG).toLowerCase();
    if (existingMap.has(key)) {
      updates.push({ ...row, ID: existingMap.get(key) });
    } else {
      inserts.push(row);
    }
  }
  return { inserts, updates, passthrough };
}

// Look up which lowercased slugs already exist in target. Chunks the IN-list
// to keep individual statements under HANA's parameter cap (32k); 500 is a
// friendlier round-trip size.
async function fetchExistingSlugMap(target, fullTable, slugs) {
  const existingMap = new Map();
  if (slugs.length === 0) return existingMap;
  const CHUNK = 500;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const slice = slugs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await query(
      target,
      `SELECT "ID", LOWER("SLUG") AS "S" FROM ${fullTable} WHERE LOWER("SLUG") IN (${placeholders})`,
      slice
    );
    for (const r of rows) existingMap.set(r.S, r.ID);
  }
  return existingMap;
}

async function migrateEntity(source, target, targetSchema, config) {
  const { name, sourceQuery, targetTable, mapRow, preInsert, upsertOnSlug = false } = config;

  if (ENTITY_FILTER && !ENTITY_FILTER.includes(name)) {
    console.log(`  ⊘ Skipping ${name} (not in filter)`);
    return { name, count: 0, skipped: true };
  }

  console.log(`\n─── Migrating: ${name} ───`);

  const rows = await query(source, sourceQuery);
  console.log(`  Read ${rows.length} records from source`);

  if (rows.length === 0) return { name, count: 0 };

  if (preInsert) await preInsert(target, targetSchema);

  const fullTable = `"${targetSchema}"."${targetTable}"`;

  // Map all rows and filter nulls
  const mapped = [];
  for (const row of rows) {
    const m = mapRow(row);
    if (m) mapped.push(m);
  }

  // Decide whether to take the slug-aware upsert path. The flag is per-config,
  // but we also require at least one mapped row to actually carry a SLUG —
  // otherwise we fall through to the original delete-then-insert path (e.g.
  // groups/missions whose mapRow doesn't emit SLUG; their slugs are assigned
  // post-migration by setup-dev-data.cjs).
  const hasSlugColumn = upsertOnSlug && mapped.length > 0
    && mapped[0].SLUG !== undefined && mapped[0].SLUG !== null;

  if (!hasSlugColumn) {
    // Original path: clear the target then batch-INSERT everything.
    if (!DRY_RUN) {
      const existing = await query(target, `SELECT COUNT(*) AS "C" FROM ${fullTable}`);
      if (existing[0].C > 0) {
        console.log(`  Clearing ${existing[0].C} existing records in target...`);
        await execStmt(target, `DELETE FROM ${fullTable}`);
      }
    }

    if (DRY_RUN) {
      mapped.slice(0, 3).forEach(m => console.log(`  [dry-run] Would insert:`, JSON.stringify(m).slice(0, 200)));
      console.log(`  ✓ ${mapped.length} inserted, 0 errors`);
      return { name, count: mapped.length };
    }

    const result = await batchInsert(target, fullTable, mapped);
    console.log(`  ✓ ${result.inserted} inserted, ${result.errors} errors`);
    return { name, count: result.inserted, errors: result.errors };
  }

  // Upsert-on-slug path: do NOT clear the target. Look up which slugs already
  // exist, UPDATE matching rows, INSERT the rest. This is the same shape as
  // srv/lib/content-publish-session.js so a re-run of the migrator no longer
  // duplicates rows on top of already-published content. Belt-and-braces:
  // @assert.unique.slug would also block plain-INSERT duplicates, but a clean
  // no-op on re-run is friendlier than a constraint violation.
  const slugs = mapped
    .map(r => (r.SLUG == null ? '' : String(r.SLUG).toLowerCase()))
    .filter(Boolean);

  if (DRY_RUN) {
    mapped.slice(0, 3).forEach(m => console.log(`  [dry-run] Would upsert:`, JSON.stringify(m).slice(0, 200)));
    console.log(`  ✓ ${mapped.length} would be upserted (slug-keyed)`);
    return { name, count: mapped.length };
  }

  const existingMap = await fetchExistingSlugMap(target, fullTable, slugs);
  const { inserts, updates, passthrough } = partitionBySlug(mapped, existingMap);

  // Apply UPDATEs one row at a time. Updates set every column EXCEPT the
  // primary key (ID) and SLUG itself — overwriting ID would lose the existing
  // row's identity (and any FKs that point at it from prior runs); overwriting
  // SLUG is unnecessary since it's the join key.
  let updated = 0;
  let updateErrors = 0;
  for (const row of updates) {
    const setCols = Object.keys(row).filter(c => c !== 'ID' && c !== 'SLUG');
    if (setCols.length === 0) continue;
    const setClause = setCols.map(c => `"${c}" = ?`).join(', ');
    const params = [...setCols.map(c => row[c] ?? null), row.ID];
    try {
      await execStmt(target, `UPDATE ${fullTable} SET ${setClause} WHERE "ID" = ?`, params);
      updated++;
    } catch (e) {
      updateErrors++;
      if (updateErrors <= 5) console.error(`  ✗ Update error: ${e.message.split('\n')[0]}`);
    }
  }

  // INSERT the new-slug bucket plus any passthrough rows (rows whose mapRow
  // didn't emit a SLUG — should be empty in practice when hasSlugColumn is
  // true, but kept here for defence-in-depth).
  const toInsert = inserts.concat(passthrough);
  const insertResult = toInsert.length > 0
    ? await batchInsert(target, fullTable, toInsert)
    : { inserted: 0, errors: 0 };

  console.log(`  ✓ upsert: ${insertResult.inserted} inserted, ${updated} updated, ${insertResult.errors + updateErrors} errors`);
  return { name, count: insertResult.inserted + updated, errors: insertResult.errors + updateErrors };
}

// Batch-insert a list of mapped rows into `fullTable`. Falls back to row-by-row
// inside a failing batch so a single bad row doesn't sink the whole batch.
async function batchInsert(target, fullTable, mapped) {
  if (mapped.length === 0) return { inserted: 0, errors: 0 };

  const cols = Object.keys(mapped[0]);
  const colNames = cols.map(c => `"${c}"`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const insertSQL = `INSERT INTO ${fullTable} (${colNames}) VALUES (${placeholders})`;
  const stmt = await prepare(target, insertSQL);

  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const batch = mapped.slice(i, i + BATCH_SIZE);
    const paramRows = batch.map(row => cols.map(c => row[c] ?? null));

    try {
      await execBatch(stmt, paramRows);
      inserted += batch.length;
    } catch (e) {
      // Fallback: try row-by-row for this batch to identify problematic rows
      for (const params of paramRows) {
        try {
          await execBatch(stmt, [params]);
          inserted++;
        } catch (rowErr) {
          errors++;
          if (errors <= 5) console.error(`  ✗ Row error: ${rowErr.message.split('\n')[0]}`);
        }
      }
    }

    if (i > 0 && i % (BATCH_SIZE * 5) === 0) {
      process.stdout.write(`  ${inserted}/${mapped.length} inserted...\r`);
    }
  }

  stmt.drop();
  return { inserted, errors };
}

// Paginated migration for entities too large to fit in memory. Walks the source
// in id-keyed page slices (default 50_000 rows) and feeds each page through the
// same map → batch-insert pipeline as migrateEntity. Caller supplies
// `sourceQueryForRange(min, max)` returning the SELECT for `id IN (min, max]`.
// Issue #332 — IMS prod TaskRecords is large enough to OOM the single-shot path.
async function migrateEntityPaginated(source, target, targetSchema, config) {
  const { name, idColumn, idMin, idMax, pageSize, sourceQueryForRange, targetTable, mapRow, preInsert } = config;

  if (ENTITY_FILTER && !ENTITY_FILTER.includes(name)) {
    console.log(`  ⊘ Skipping ${name} (not in filter)`);
    return { name, count: 0, skipped: true };
  }

  console.log(`\n─── Migrating: ${name} (paginated by ${idColumn}) ───`);
  console.log(`  Range: ${idMin}..${idMax}, pageSize=${pageSize}`);

  if (preInsert) await preInsert(target, targetSchema);

  const fullTable = `"${targetSchema}"."${targetTable}"`;
  if (!DRY_RUN) {
    const existing = await query(target, `SELECT COUNT(*) AS "C" FROM ${fullTable}`);
    if (existing[0].C > 0) {
      console.log(`  Clearing ${existing[0].C} existing records in target...`);
      await execStmt(target, `DELETE FROM ${fullTable}`);
    }
  }

  let stmt = null;
  let cols = null;
  let inserted = 0;
  let errors = 0;
  let totalRead = 0;

  for (let lo = idMin - 1; lo < idMax; lo += pageSize) {
    const hi = Math.min(lo + pageSize, idMax);
    const pageSql = sourceQueryForRange(lo, hi);
    const pageRows = await query(source, pageSql);
    totalRead += pageRows.length;
    if (pageRows.length === 0) continue;

    const mapped = [];
    for (const row of pageRows) {
      const m = mapRow(row);
      if (m) mapped.push(m);
    }

    if (DRY_RUN) {
      // Print samples from the first non-empty page only.
      if (inserted === 0 && mapped.length > 0) {
        mapped.slice(0, 3).forEach(m => console.log(`  [dry-run] Would insert:`, JSON.stringify(m).slice(0, 200)));
      }
      inserted += mapped.length;
      process.stdout.write(`  page ${lo + 1}..${hi}: read=${pageRows.length} mapped=${mapped.length} (running total mapped=${inserted})\r`);
      continue;
    }

    if (mapped.length === 0) continue;
    if (!stmt) {
      cols = Object.keys(mapped[0]);
      const colNames = cols.map(c => `"${c}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      stmt = await prepare(target, `INSERT INTO ${fullTable} (${colNames}) VALUES (${placeholders})`);
    }

    for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
      const batch = mapped.slice(i, i + BATCH_SIZE);
      const paramRows = batch.map(row => cols.map(c => row[c] ?? null));
      try {
        await execBatch(stmt, paramRows);
        inserted += batch.length;
      } catch (e) {
        for (const params of paramRows) {
          try { await execBatch(stmt, [params]); inserted++; }
          catch (rowErr) {
            errors++;
            if (errors <= 5) console.error(`  ✗ Row error: ${rowErr.message.split('\n')[0]}`);
          }
        }
      }
    }
    process.stdout.write(`  page ${lo + 1}..${hi}: ${inserted} inserted, ${errors} errors\r`);
  }

  if (stmt) stmt.drop();
  console.log(`\n  ✓ ${inserted} inserted, ${errors} errors (read ${totalRead} from source)`);
  return { name, count: inserted, errors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  IMS HANA → CAP HANA Direct Migration               ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  ⚠ DRY RUN MODE — no data will be written');
  if (DISCOVER) console.log('  ⚠ DISCOVER MODE — listing tables only');
  console.log('');

  if (LIST_ENTITIES) {
    const order = [
      ['1', 'tags', 'reference', 'IMS_TAG'],
      ['2', 'events', 'reference', 'IMS_EVENT'],
      ['3', 'groups', 'reference', 'IMS_TASK (TASK_TYPE=GROUP)'],
      ['4', 'missions', 'reference', 'IMS_TASK (TASK_TYPE=MISSION)'],
      ['5', 'tutorials', 'reference', 'IMS_TASK (TASK_TYPE=TUTORIAL)'],
      ['6', 'steps', 'reference', 'IMS_TASK (TASK_TYPE=STEP)'],
      ['7', 'users', 'activity', 'IMS_USER'],
      ['8', 'taskrecords', 'activity', 'IMS_TASK_RECORD'],
      ['9', 'completionpaths', 'reference', 'IMS_COMPLETION_PATH'],
      ['10', 'completionpathitems', 'reference', 'IMS_COMPLETION_PATH_TO_TASK'],
      ['11', 'prizes', 'reference', 'IMS_PRIZE'],
      ['11b', 'accomplishments', 'reference', 'IMS_ACCOMPLISHMENT'],
      ['11c', 'accomplishmentrecords', 'activity', 'IMS_ACCOMPLISHMENT_RECORD'],
      ['11d', 'prizerecords', 'activity', 'IMS_PRIZE_RECORD'],
      ['12', 'tutorialtags', 'reference', 'IMS_TAG_TO_TASK'],
      ['13', 'featuredtasks', 'reference', 'IMS_TASK (FEATURED_ORDER > 0)'],
    ];
    console.log('Migration order (FK-correct):\n');
    for (const [n, name, klass, src] of order) {
      console.log(`  ${n.padStart(3)}. ${name.padEnd(22)} ${klass.padEnd(10)} ← ${src}`);
    }
    console.log('\n  reference = zero-diff tolerance | activity = ±2 tolerance');
    console.log('  Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md\n');
    process.exit(0);
  }

  console.log('Resolving source credentials...');
  let imsCreds;
  if (process.env.IMS_HANA_CREDENTIALS) {
    imsCreds = JSON.parse(process.env.IMS_HANA_CREDENTIALS);
  } else if (process.env.IMS_DB_URL) {
    const url = new URL(process.env.IMS_DB_URL.replace('jdbc:sap://', 'https://'));
    imsCreds = {
      host: url.hostname,
      port: url.port || '443',
      user: process.env.IMS_DB_USERNAME,
      password: process.env.IMS_DB_PASSWORD,
      schema: url.searchParams.get('currentschema') || process.env.IMS_DB_USERNAME,
    };
  } else {
    imsCreds = getCredentials(SOURCE_INSTANCE, SOURCE_KEY);
  }
  console.log(`  Source: ${imsCreds.host?.slice(0, 30)}... user=${imsCreds.user} schema=${imsCreds.schema}`);

  console.log('\nConnecting to source HANA...');
  const source = await connect(imsCreds, 'source');
  await execStmt(source, `SET SCHEMA "${imsCreds.schema}"`);
  console.log('  ✓ Connected to source');

  // ─── Discovery mode ─────────────────────────────────────────────────────────
  if (DISCOVER) {
    console.log('\n─── Discovering source tables ───');
    const approaches = [
      { label: 'Container schema', sql: `SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = '${imsCreds.schema}' ORDER BY TABLE_NAME` },
      { label: 'All related schemas', sql: `SELECT SCHEMA_NAME, TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME LIKE '${imsCreds.schema.slice(0, 10)}%' AND SCHEMA_NAME NOT LIKE '%#DI' ORDER BY SCHEMA_NAME, TABLE_NAME` },
      { label: 'Direct IMS_TASK query', sql: 'SELECT TOP 1 "ID", "TITLE", "TASK_TYPE" FROM "IMS_TASK"' },
      { label: 'Direct ims_task (lowercase)', sql: 'SELECT TOP 1 * FROM "ims_task"' },
    ];

    for (const { label, sql } of approaches) {
      try {
        const rows = await query(source, sql);
        console.log(`  ✓ ${label}: ${rows.length} results`);
        rows.slice(0, 10).forEach(r => console.log(`    `, JSON.stringify(r).slice(0, 150)));
      } catch (e) {
        console.log(`  ✗ ${label}: ${e.message.split('\n')[0].slice(0, 100)}`);
      }
    }

    // Try RT user too
    console.log('\n  Trying with RT user...');
    try {
      const sourceRT = await connect({ ...imsCreds, hdi_user: null, hdi_password: null }, 'source-RT');
      await execStmt(sourceRT, `SET SCHEMA "${imsCreds.schema}"`);
      const rtTables = await query(sourceRT, `SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = '${imsCreds.schema}'`);
      console.log(`  RT user tables: ${rtTables.length}`);
      rtTables.forEach(t => console.log(`    ${t.TABLE_NAME}`));
      sourceRT.disconnect();
    } catch (e) {
      console.log(`  RT user: ${e.message.split('\n')[0].slice(0, 100)}`);
    }

    source.disconnect();
    return;
  }

  // ─── Target connection ─────────────────────────────────────────────────────
  if (SOURCE_ONLY) {
    console.log('\n  --source-only: skipping target connection');
    source.disconnect();
    return;
  }

  console.log('\nResolving target credentials...');
  const capCreds = JSON.parse(process.env.CAP_HANA_CREDENTIALS || 'null')
    || getCredentials(TARGET_INSTANCE, TARGET_KEY);
  console.log(`  Target: ${capCreds.host?.slice(0, 30)}... schema=${capCreds.schema}`);

  console.log('\nConnecting to target HANA (RT user for DML)...');
  const target = await connect({ ...capCreds, hdi_user: null, hdi_password: null }, 'target');
  await execStmt(target, `SET SCHEMA "${capCreds.schema}"`);
  console.log('  ✓ Connected to target');

  const S = `"${imsCreds.schema}"`;
  const T = capCreds.schema;

  // Build lookup maps
  console.log('\nBuilding lookup maps...');
  let tagMap = new Map();
  try {
    const tags = await query(source, `SELECT "ID", "NAME" FROM ${S}."IMS_TAG"`);
    tags.forEach(t => tagMap.set(t.ID, t.NAME));
    console.log(`  Tags: ${tagMap.size} entries`);
  } catch (e) {
    console.log(`  Tags: table not found or empty (${e.message.split('\n')[0]})`);
  }

  // UUID mapping: source legacyId → generated UUID (for FK resolution)
  const uuidMap = {
    tutorials: new Map(),
    missions: new Map(),
    groups: new Map(),
    steps: new Map(),
    users: new Map(),
    events: new Map(),
    tags: new Map(),
    completionPaths: new Map(),
    prizes: new Map(),
    accomplishments: new Map(),
    contributors: new Map(),       // NEW (#385 PR-2)
    repositories: new Map(),       // NEW (#385 PR-2)
  };

  const allTasks = await query(source, `SELECT "ID", "TASK_TYPE" FROM ${S}."IMS_TASK"`);
  for (const t of allTasks) {
    const type = (t.TASK_TYPE || '').toLowerCase();
    if (type === 'tutorial') uuidMap.tutorials.set(t.ID, deriveUuid('tutorial', t.ID));
    else if (type === 'mission') uuidMap.missions.set(t.ID, deriveUuid('mission', t.ID));
    else if (type === 'group') uuidMap.groups.set(t.ID, deriveUuid('group', t.ID));
    else if (type === 'step') uuidMap.steps.set(t.ID, deriveUuid('step', t.ID));
  }
  console.log(`  Tasks: ${allTasks.length} (tutorials: ${uuidMap.tutorials.size}, missions: ${uuidMap.missions.size}, groups: ${uuidMap.groups.size}, steps: ${uuidMap.steps.size})`);

  const allUsers = await query(source, `SELECT "ID" FROM ${S}."IMS_USER"`);
  allUsers.forEach(u => uuidMap.users.set(u.ID, deriveUuid('user', u.ID)));
  console.log(`  Users: ${uuidMap.users.size}`);

  const allEvents = await query(source, `SELECT "ID" FROM ${S}."IMS_EVENT"`);
  allEvents.forEach(e => uuidMap.events.set(e.ID, deriveUuid('event', e.ID)));
  console.log(`  Events: ${uuidMap.events.size}`);

  let allTags = [];
  try {
    allTags = await query(source, `SELECT "ID" FROM ${S}."IMS_TAG"`);
    allTags.forEach(t => uuidMap.tags.set(t.ID, deriveUuid('tag', t.ID)));
    console.log(`  Tags (entities): ${uuidMap.tags.size}`);
  } catch (e) { /* table might not exist */ }

  let hasCompletionPaths = false;
  try {
    const cpCount = await query(source, `SELECT COUNT(*) AS "C" FROM ${S}."IMS_COMPLETION_PATH"`);
    hasCompletionPaths = cpCount[0].C > 0;
    if (hasCompletionPaths) {
      const cps = await query(source, `SELECT "ID" FROM ${S}."IMS_COMPLETION_PATH"`);
      cps.forEach(cp => uuidMap.completionPaths.set(cp.ID, deriveUuid('completionpath', cp.ID)));
      console.log(`  CompletionPaths: ${uuidMap.completionPaths.size}`);
    }
  } catch (e) { /* optional table */ }

  try {
    const prizes = await query(source, `SELECT "ID" FROM ${S}."IMS_PRIZE"`);
    prizes.forEach(p => uuidMap.prizes.set(p.ID, deriveUuid('prize', p.ID)));
    console.log(`  Prizes: ${uuidMap.prizes.size}`);
  } catch (e) { /* optional table */ }

  try {
    const accs = await query(source, `SELECT "ID" FROM ${S}."IMS_ACCOMPLISHMENT"`);
    accs.forEach(a => uuidMap.accomplishments.set(a.ID, deriveUuid('accomplishment', a.ID)));
    console.log(`  Accomplishments: ${uuidMap.accomplishments.size}`);
  } catch (e) { /* optional table */ }

  // #385 PR-2: build contributor + repository uuidMaps. Both source tables are
  // optional from the migrator's POV — if missing (e.g. older IMS instance),
  // migration of dependent entities just skips silently.
  try {
    const contributors = await query(source, `SELECT "ID" FROM ${S}."IMS_TUTORIAL_AUTHOR"`);
    contributors.forEach(c => uuidMap.contributors.set(c.ID, deriveUuid('tutorialcontributor', c.ID)));
    console.log(`  TutorialContributors: ${uuidMap.contributors.size}`);
  } catch (e) { /* optional table */ }

  // Note: uuidMap.repositories is built for symmetry with other entities and to
  // give future migration code an FK-resolution hook. The current mapRow path
  // re-derives the same UUID via deriveUuid() so the map isn't strictly required
  // today, but populating it costs only one extra SELECT.
  try {
    const repositories = await query(source, `SELECT "ID" FROM ${S}."IMS_TUTORIAL_REPOSITORY"`);
    repositories.forEach(r => uuidMap.repositories.set(r.ID, deriveUuid('tutorialrepository', r.ID)));
    console.log(`  TutorialRepositories: ${uuidMap.repositories.size}`);
  } catch (e) { /* optional table */ }

  // Step parent mapping: step ID → { parentId (tutorial), order }
  const stepParentMap = new Map();
  try {
    const parents = await query(source, `SELECT "CHILD_TASK_ID", "PARENT_TASK_ID", "TASK_ORDER" FROM ${S}."IMS_TASK_TO_PARENT"`);
    parents.forEach(p => stepParentMap.set(p.CHILD_TASK_ID, { parentId: p.PARENT_TASK_ID, order: p.TASK_ORDER }));
    console.log(`  Task-to-parent links: ${stepParentMap.size}`);
  } catch (e) { /* optional */ }

  // Pre-compute per-tutorial step counts so Tutorials.stepCount can be
  // populated at migration time (was NULL for 1391/~1397 tutorials in the
  // 2026-06-20 cutover audit, which broke _updateTutorialProgress's rollup
  // denominator).
  const tutorialStepCount = computeTutorialStepCount(stepParentMap);
  console.log(`  Per-tutorial step counts: ${tutorialStepCount.size} tutorials`);

  // Mission-to-group mapping: INTENTIONALLY EMPTY.
  // IMS does NOT model missions as children of groups (probed 2026-06-15:
  // SELECT ... FROM IMS_TASK_TO_PARENT ttp JOIN IMS_TASK m ON m.ID = ttp.CHILD_TASK_ID
  // AND m.TASK_TYPE='MISSION' returns 0 rows in either direction). Missions stand
  // alone in IMS; the group-of-missions relationship lives only in the CAP v2
  // schema. Migrated missions therefore land with GROUP_ID NULL. The legitimate
  // mission grouping is via CompletionPaths.mission, not Missions.group_id.
  // Issue #333.
  const missionGroupMap = new Map();

  // ─── Entity migrations (order matters for FK integrity) ─────────────────────
  const results = [];

  // 1. Tags — extended for #385 PR-2 (3 new source columns).
  results.push(await migrateEntity(source, target, T, {
    name: 'tags',
    sourceQuery: `SELECT "ID", "NAME", "SEMAPHORE_ID", "IS_ACTUAL_TAG", "IS_INTEREST_ITEM" FROM ${S}."IMS_TAG"`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_TAGS',
    mapRow: (row) => mapTagRow(row, uuidMap.tags.get(row.ID)),
  }));

  // 2. Events
  results.push(await migrateEntity(source, target, T, {
    name: 'events',
    sourceQuery: `SELECT "ID", "NAME", "START_DATE", "END_DATE", "TIME_ZONE", "CREATED_AT", "UPDATED_AT", "CREATED_BY", "UPDATED_BY" FROM ${S}."IMS_EVENT"`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_EVENTS',
    mapRow: (row) => ({
      ID: uuidMap.events.get(row.ID),
      LEGACYID: row.ID,
      NAME: row.NAME,
      STARTDATE: toISOTimestamp(row.START_DATE),
      ENDDATE: toISOTimestamp(row.END_DATE),
      TIMEZONE: row.TIME_ZONE,
      CREATEDAT: toISOTimestamp(row.CREATED_AT),
      MODIFIEDAT: toISOTimestamp(row.UPDATED_AT),
      CREATEDBY: row.CREATED_BY || 'migration',
      MODIFIEDBY: row.UPDATED_BY || 'migration',
    }),
  }));

  // 3. Groups
  results.push(await migrateEntity(source, target, T, {
    name: 'groups',
    sourceQuery: `SELECT "ID", "TITLE", "TASK_STATUS", "CREATED_AT", "UPDATED_AT", "CREATED_BY", "UPDATED_BY" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'GROUP'`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_GROUPS',
    mapRow: (row) => ({
      ID: uuidMap.groups.get(row.ID),
      LEGACYID: row.ID,
      TITLE: truncStr(row.TITLE, 255),
      STATUS: normalizeStatus(row.TASK_STATUS),
      PUBLISHED: derivePublished(row.TASK_STATUS),
      CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
      MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
      CREATEDBY: truncStr(row.CREATED_BY, 255) || 'migration',
      MODIFIEDBY: truncStr(row.UPDATED_BY, 255) || 'migration',
    }),
    // Groups.slug is nullable and the migrator's mapRow doesn't emit SLUG —
    // slugs are assigned post-migration by setup-dev-data.cjs. The flag is a
    // no-op here in practice (rows fall through to the original delete-then-
    // insert path), but kept for symmetry/future-proofing if a migrator
    // generation ever populates Groups.slug.
    upsertOnSlug: true,
  }));

  // 4. Missions
  results.push(await migrateEntity(source, target, T, {
    name: 'missions',
    sourceQuery: `SELECT "ID", "TITLE", "TASK_STATUS", "CREATED_AT", "UPDATED_AT", "CREATED_BY", "UPDATED_BY" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'MISSION'`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_MISSIONS',
    mapRow: (row) => {
      const groupLegacyId = missionGroupMap.get(row.ID);
      return {
        ID: uuidMap.missions.get(row.ID),
        LEGACYID: row.ID,
        TITLE: truncStr(row.TITLE, 255),
        STATUS: normalizeStatus(row.TASK_STATUS),
        PUBLISHED: derivePublished(row.TASK_STATUS),
        GROUP_ID: groupLegacyId ? uuidMap.groups.get(groupLegacyId) : null,
        CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
        MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
        CREATEDBY: truncStr(row.CREATED_BY, 255) || 'migration',
        MODIFIEDBY: truncStr(row.UPDATED_BY, 255) || 'migration',
      };
    },
    // Same caveat as `groups`: Missions.slug is nullable and not emitted by
    // mapRow today; flag kept for symmetry / future migrator generations.
    upsertOnSlug: true,
  }));

  // 5. Tutorials
  // Java IMS sometimes has multiple IMS_TASK rows pointing to the same source
  // markdown URL (most commonly an ACTIVE + DELETED pair). The migrator
  // derives SLUG from the URL filename, so colliding rows would map to the
  // same slug and the second INSERT would hit the
  // COM_SAP_DEVELOPERS_IMS_TUTORIALS_SLUG unique index. Sort the source so
  // ACTIVE-with-recent-UPDATED_AT wins (claims the preferred slug); DELETED
  // or older rows get suffixed by dedupeTutorialSlug. Issue #473.
  const _tutorialSlugSeen = new Set();
  results.push(await migrateEntity(source, target, T, {
    name: 'tutorials',
    sourceQuery: `SELECT "ID", "TITLE", "TASK_STATUS", "URL", "PRIMARY_TAG_ID", "EXPERIENCE_TAG_ID", "AVERAGE_TTC", "FEATURED_ORDER", "CREATED_AT", "UPDATED_AT", "CREATED_BY", "UPDATED_BY" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'TUTORIAL' ORDER BY (CASE WHEN "TASK_STATUS" = 'DELETED' THEN 1 ELSE 0 END), "UPDATED_AT" DESC`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALS',
    mapRow: (row) => ({
      ID: uuidMap.tutorials.get(row.ID),
      LEGACYID: row.ID,
      TITLE: truncStr(row.TITLE, 255),
      STATUS: normalizeStatus(row.TASK_STATUS),
      // IMS source stores tutorial slugs as the markdown filename
      // (e.g. "abap-environment-maintain-bc-app.md"). Hugo serves
      // tutorials at /tutorials/<slug-without-md>, and /build/catalog
      // emits whatever's in the SLUG column verbatim. Without this
      // strip, Hugo's tutorial cache (keyed off the .md-less slug)
      // never matches the catalog mappings, so the navigator emits
      // 0 mission/group cards. Surfaced 2026-06-16 cutover rehearsal.
      //
      // Issue #473: dedupe in-pass so an ACTIVE+DELETED collision pair
      // doesn't trip the @assert.unique.slug constraint. The ORDER BY
      // on the source query ensures the surviving ACTIVE row claims
      // the preferred slug; the loser gets `${rawSlug}-${legacyId}`.
      SLUG: truncStr(
        dedupeTutorialSlug(
          ((row.URL || '').split('/').pop() || '').replace(/\.md$/i, ''),
          row.ID,
          _tutorialSlugSeen
        ),
        255
      ),
      MDFILEURL: truncStr(row.URL, 1000),
      PRIMARYTAG: truncStr(tagMap.get(row.PRIMARY_TAG_ID), 255) || null,
      EXPERIENCETAG: truncStr(tagMap.get(row.EXPERIENCE_TAG_ID), 255) || null,
      AVERAGETIMETOCOMPLETE: row.AVERAGE_TTC,
      FEATUREDORDER: row.FEATURED_ORDER,
      // STEPCOUNT was previously NULL for 1391/~1397 tutorials post-migration
      // because the migrator never set it. Populate from the per-tutorial
      // pre-aggregation built off IMS_TASK_TO_PARENT. _updateTutorialProgress
      // uses this as the rollup denominator. Issue #466.
      STEPCOUNT: tutorialStepCount.get(row.ID) ?? null,
      CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
      MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
      CREATEDBY: truncStr(row.CREATED_BY, 255) || 'migration',
      MODIFIEDBY: truncStr(row.UPDATED_BY, 255) || 'migration',
    }),
    // Tutorials.slug is @mandatory and emitted from URL filename above. The
    // 2026-06-16 cutover rehearsal duplicated rows when multiple source
    // legacyIds resolved to the same slug; the upsert path now matches on
    // LOWER(SLUG) (mirroring srv/lib/content-publish-session.js) so a re-run
    // updates rather than dup-inserts. Issue #338.
    upsertOnSlug: true,
  }));

  // 6. Steps
  //
  // Orphan-skip behavior (added 2026-06-21): if a Step has no parent link
  // in IMS_TASK_TO_TASK (`stepParentMap.get(row.ID)` returns null), the
  // mapRow returns `null` and migrateEntity skips the insert. Previously
  // these became silent orphan rows with TUTORIAL_ID=NULL + STEPORDER=0,
  // which HANA's @assert.unique.tutorialStep treats as duplicates (NULL=NULL
  // for unique-constraint purposes) — 5 such orphans blocked the deploy
  // on 2026-06-21. The schema-side `tutorial : Association to Tutorials
  // not null` is the belt-and-suspenders guard; this migrator skip is the
  // first line of defense.
  //
  // Orphan count is logged as a stderr warning so it surfaces in CI output.
  let orphanStepCount = 0;
  results.push(await migrateEntity(source, target, T, {
    name: 'steps',
    sourceQuery: `SELECT "ID", "TITLE", "TASK_STATUS", "CREATED_AT", "UPDATED_AT" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'STEP'`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_STEPS',
    mapRow: (row) => {
      const parent = stepParentMap.get(row.ID);
      const tutorialUuid = parent ? uuidMap.tutorials.get(parent.parentId) : null;
      if (!tutorialUuid) {
        // No resolvable tutorial parent. Skip the insert. These rows would
        // otherwise become deploy-blocking orphans (see schema comment on
        // Steps.tutorial). Caller has no use for an unattached Step row —
        // no tutorial means no rendering surface, no completion target,
        // no user progress can attach to it.
        orphanStepCount++;
        return null;
      }
      return {
        ID: uuidMap.steps.get(row.ID),
        LEGACYID: row.ID,
        TITLE: truncStr(row.TITLE, 255),
        STATUS: normalizeStatus(row.TASK_STATUS),
        TUTORIAL_ID: tutorialUuid,
        // Java IMS uses 0-based TASK_ORDER; CAP publish writes 1-based stepOrder.
        // Normalize at migration time so both populations share a single key
        // space — this prevents the duplicate-Step-row corruption that affected
        // 1372/1397 tutorials in the 2026-06 cutover (audited 2026-06-20).
        STEPORDER: parent.order != null ? parent.order + 1 : 1,
        CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
        MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
        CREATEDBY: 'migration',
        MODIFIEDBY: 'migration',
      };
    },
  }));
  if (orphanStepCount > 0) {
    console.warn(
      `  ⚠ ${orphanStepCount} orphan Step row(s) skipped during migration ` +
      `(no parent in IMS_TASK_TO_TASK). This is expected when source IMS has ` +
      `dangling task-of-step references; the rows have no rendering target ` +
      `in CAP. Increase verbose logging if these counts surprise you.`
    );
  }

  // 7. Users
  results.push(await migrateEntity(source, target, T, {
    name: 'users',
    sourceQuery: `SELECT "ID", "UUID", "SAP_ID" FROM ${S}."IMS_USER"`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_USERS',
    mapRow: (row) => ({
      ID: uuidMap.users.get(row.ID),
      LEGACYID: row.ID,
      UUID: row.UUID,
      SAPID: row.SAP_ID,
      CREATEDAT: new Date().toISOString(),
      MODIFIEDAT: new Date().toISOString(),
      CREATEDBY: 'migration',
      MODIFIEDBY: 'migration',
    }),
  }));

  // Audit: surface users with NULL sapId. They land in the DB so their
  // TaskRecords have a FK target, but they're invisible to /api/getProgress
  // (developer-service.js looks up by sapId; missing → returns 0/0/0). Emit
  // count + write the legacyIds out so post-migration ops can either
  // reconcile or hard-delete. Issue #466 — 472 such users in the 2026-06-20
  // cutover audit.
  if (!DRY_RUN) {
    const audit = await auditNullSapidUsers(source, imsCreds.schema, query);
    if (audit.error) {
      console.warn(`  ⚠️  could not audit null-sapid users: ${audit.error}`);
    } else if (audit.count > 0) {
      console.warn(`  ⚠️  ${audit.count} users have NULL SAP_ID. Wrote legacyIds to ${audit.path}.`);
    }
  }

  // 7b. UserMetaData — INTENTIONALLY NOT MIGRATED.
  // The CAP UserMetaData entity (db/schema.cds:127-131) models a per-user
  // key/value store. The IMS source IMS_USER_META_DATA is a visitor-ID
  // tracking table with completely different columns (USER_ID, VISITOR_ID,
  // CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT — no ID/KEY/VALUE).
  // The CDS entity is a v2 design IMS never used; nothing to migrate.
  // See issue #330. Caught during 2026-06-15 cutover-rehearsal dry-run.

  // 7c. TutorialContributors — global flat author table (#385 PR-2).
  // Source IMS_TUTORIAL_AUTHOR has no tutorial_id FK; rows are the global pool
  // of named authors. CAP TutorialContributors.tutorial is nullable so migrated
  // rows land with tutorial_ID = NULL. PR-1 reshape made
  // TutorialRepositories.repositoryOwner an Association to this entity, so
  // these rows MUST exist before tutorialrepositories migrates.
  if (uuidMap.contributors.size > 0) {
    results.push(await migrateEntity(source, target, T, {
      name: 'tutorialcontributors',
      sourceQuery: `SELECT "ID", "NAME", "EMAIL" FROM ${S}."IMS_TUTORIAL_AUTHOR"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS',
      mapRow: (row) => mapTutorialContributorRow(row),
    }));
  }

  // 7d. TutorialRepositories — repo-group reference table (#385 PR-2).
  // PR-1 reshape; source IMS_TUTORIAL_REPOSITORY =
  // (id, repository_name UNIQUE, repository_owner_id).
  // repositoryOwner_ID resolves through uuidMap.contributors built above.
  if (uuidMap.repositories.size > 0) {
    results.push(await migrateEntity(source, target, T, {
      name: 'tutorialrepositories',
      sourceQuery: `SELECT "ID", "REPOSITORY_NAME", "REPOSITORY_OWNER_ID" FROM ${S}."IMS_TUTORIAL_REPOSITORY"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES',
      mapRow: (row) => mapTutorialRepositoryRow(row, uuidMap.contributors),
    }));
  }

  // 8. Task Records — paginated by ID range to bypass the OOM that otherwise
  // hits at IMS prod scale (~10M+ rows). Issue #332.
  // Probe the actual range first so we don't iterate over empty space.
  const tr = await query(source, `SELECT MIN("ID") AS "LO", MAX("ID") AS "HI", COUNT(*) AS "C" FROM ${S}."IMS_TASK_RECORD"`);
  const trMin = Number(tr[0].LO ?? 0);
  const trMax = Number(tr[0].HI ?? 0);
  const trCount = Number(tr[0].C ?? 0);
  console.log(`\n  TaskRecord ID range: ${trMin}..${trMax} (${trCount} rows)`);
  if (trCount > 0) {
    results.push(await migrateEntityPaginated(source, target, T, {
      name: 'taskrecords',
      idColumn: 'ID',
      idMin: trMin,
      idMax: trMax,
      pageSize: 50_000,
      sourceQueryForRange: (lo, hi) => `SELECT "ID", "USER_ID", "TASK_ID", "EVENT_ID", "TASK_TYPE", "STATUS", "COMPLETION_TIME", "PROGRESS", "CONTENT_LANGUAGE", "SITE_LANGUAGE", "SUBMISSION_ID_STARTED", "SUBMISSION_ID_COMPLETED", "CREATED_AT", "UPDATED_AT" FROM ${S}."IMS_TASK_RECORD" WHERE "ID" > ${lo} AND "ID" <= ${hi}`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_TASKRECORDS',
      mapRow: (row) => ({
        ID: deriveUuid('taskrecord', row.ID),
        LEGACYID: row.ID,
        USER_ID: uuidMap.users.get(row.USER_ID) || null,
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
        EVENT_ID: row.EVENT_ID ? uuidMap.events.get(row.EVENT_ID) : null,
        CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
        MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
        CREATEDBY: 'migration',
        MODIFIEDBY: 'migration',
      }),
    }));
  }

  // 9. Completion Paths
  if (hasCompletionPaths) {
    // Slug derivation: Java IMS doesn't store slugs (CAP-side concept). The
    // pre-2026-06-20 migrator left CompletionPaths.SLUG NULL for all 311 rows,
    // which broke /build/catalog. Generate from title; fall back to
    // `path-${legacyId}` for missing/empty input. Collisions resolved via the
    // `seen` Set scoped to this entity migration. Issue #466.
    const _completionPathSlugSeen = new Set();
    results.push(await migrateEntity(source, target, T, {
      name: 'completionpaths',
      sourceQuery: `SELECT "ID", "MISSION_ID", "TITLE", "DESCRIPTION", "PATH_ORDER" FROM ${S}."IMS_COMPLETION_PATH"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS',
      mapRow: (row) => ({
        ID: uuidMap.completionPaths.get(row.ID),
        LEGACYID: row.ID,
        MISSION_ID: uuidMap.missions.get(row.MISSION_ID) || null,
        NAME: truncStr(row.TITLE, 255),
        SLUG: truncStr(deriveCompletionPathSlug(row.TITLE, row.ID, _completionPathSlugSeen), 255),
      }),
    }));

    // 10. Completion Path Items
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'completionpathitems',
        sourceQuery: `SELECT "ID", "PATH_ID", "TASK_ID", "COMPLETION_PATH_ORDER" FROM ${S}."IMS_COMPLETION_PATH_TO_TASK"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS',
        mapRow: (row) => {
          // Resolve the TASK_ID against each entity-type UUID map. The
          // typed FK columns (TUTORIAL_ID, GROUP_ID) on the target are
          // what the navigator-catalog handler reads — without them set,
          // missions whose CompletionPathItems point at GROUPs (the
          // "nested groups" pattern, ~17 of 87 published missions on
          // 2026-06-16 cutover) drop out of /build/navigator entirely.
          let taskType = null;
          let tutorialId = null;
          let groupId = null;
          if (uuidMap.tutorials.has(row.TASK_ID)) {
            taskType = 'TUTORIAL';
            tutorialId = uuidMap.tutorials.get(row.TASK_ID);
          } else if (uuidMap.missions.has(row.TASK_ID)) {
            taskType = 'MISSION';
            // CPI schema has no MISSION_ID column; current data has zero
            // taskType='MISSION' rows. Leave both FKs null.
          } else if (uuidMap.groups.has(row.TASK_ID)) {
            taskType = 'GROUP';
            groupId = uuidMap.groups.get(row.TASK_ID);
          }

          return {
            ID: deriveUuid('completionpathitem', row.ID),
            LEGACYID: row.ID,
            PATH_ID: uuidMap.completionPaths.get(row.PATH_ID) || null,
            TASKLEGACYID: row.TASK_ID,
            TASKTYPE: taskType,
            TUTORIAL_ID: tutorialId,
            GROUP_ID: groupId,
            ITEMORDER: row.COMPLETION_PATH_ORDER,
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ Completion path items: ${e.message.split('\n')[0]}`);
    }

    // 10b. Group → Tutorial path items (CAP-era table; IMS holds the
    // relationship in IMS_TASK_TO_PARENT where parent.task_type='GROUP'
    // and child.task_type='TUTORIAL'). Without this, the navigator
    // handler's standalone-group + nested-group paths can't surface
    // tutorials for ~122 of the 193 published groups (2026-06-16
    // cutover). 820 source links exist on prod IMS.
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'grouppathitems',
        sourceQuery: `SELECT
          ttp."PARENT_TASK_ID" AS "GROUP_LEGACYID",
          ttp."CHILD_TASK_ID"  AS "TUT_LEGACYID",
          ROW_NUMBER() OVER (PARTITION BY ttp."PARENT_TASK_ID" ORDER BY ttp."CHILD_TASK_ID") AS "ITEM_ORDER"
        FROM ${S}."IMS_TASK_TO_PARENT" ttp
        INNER JOIN ${S}."IMS_TASK" p ON p."ID" = ttp."PARENT_TASK_ID"
        INNER JOIN ${S}."IMS_TASK" c ON c."ID" = ttp."CHILD_TASK_ID"
        WHERE p."TASK_TYPE" = 'GROUP' AND c."TASK_TYPE" = 'TUTORIAL'
        ORDER BY ttp."PARENT_TASK_ID", ttp."CHILD_TASK_ID"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS',
        mapRow: (row) => {
          const groupUuid = uuidMap.groups.get(row.GROUP_LEGACYID);
          const tutorialUuid = uuidMap.tutorials.get(row.TUT_LEGACYID);
          if (!groupUuid || !tutorialUuid) return null;
          // Re-use the completionpathitem namespace; legacyIds from this
          // source table don't collide with IMS_COMPLETION_PATH_TO_TASK,
          // and the input keys are namespaced with a "gpi:" prefix so the
          // derived UUIDs are stable across re-runs and never overlap.
          return {
            ID: uuidv5(`gpi:${row.GROUP_LEGACYID}:${row.TUT_LEGACYID}`, NAMESPACES.completionpathitem),
            GROUP_ID: groupUuid,
            TUTORIAL_ID: tutorialUuid,
            ITEMORDER: row.ITEM_ORDER,
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ Group path items: ${e.message.split('\n')[0]}`);
    }
  }

  // 11. Prizes
  if (uuidMap.prizes.size > 0) {
    results.push(await migrateEntity(source, target, T, {
      name: 'prizes',
      sourceQuery: `SELECT "ID", "NAME" FROM ${S}."IMS_PRIZE"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_PRIZES',
      mapRow: (row) => ({
        ID: uuidMap.prizes.get(row.ID),
        LEGACYID: row.ID,
        NAME: truncStr(row.NAME, 255),
        EVENT_ID: null,
      }),
    }));
  }

  // 11b. Accomplishments catalog (CAP entity: Accomplishments)
  // FK shape: parent of AccomplishmentRecords. No own FKs.
  if (uuidMap.accomplishments.size > 0) {
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'accomplishments',
        sourceQuery: `SELECT "ID", "NAME", CAST("RULE" AS NVARCHAR(5000)) AS "RULE", CAST("DESCRIPTION" AS NVARCHAR(2000)) AS "DESCRIPTION" FROM ${S}."IMS_ACCOMPLISHMENT"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS',
        mapRow: (row) => ({
          ID: uuidMap.accomplishments.get(row.ID),
          LEGACYID: row.ID,
          NAME: truncStr(row.NAME, 255),
          RULE: truncStr(row.RULE, 2000),
          DESCRIPTION: truncStr(row.DESCRIPTION, 1000),
        }),
      }));
    } catch (e) {
      console.log(`  ⊘ Accomplishments: ${e.message.split('\n')[0]}`);
    }
  }

  // 11c. AccomplishmentRecords (user-earned badges)
  // FKs: user_id → Users; accomplishment_id → Accomplishments.
  // IMS source column for the awarded timestamp is "DATE" (per probe of
  // SYS.TABLE_COLUMNS on 2026-06-15), not "AWARDED_AT". Issue #331.
  if (uuidMap.users.size > 0 && uuidMap.accomplishments.size > 0) {
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'accomplishmentrecords',
        sourceQuery: `SELECT "ID", "USER_ID", "ACCOMPLISHMENT_ID", "DATE" FROM ${S}."IMS_ACCOMPLISHMENT_RECORD"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS',
        mapRow: (row) => {
          const userUuid = uuidMap.users.get(row.USER_ID);
          const accUuid = uuidMap.accomplishments.get(row.ACCOMPLISHMENT_ID);
          if (!userUuid || !accUuid) return null;
          return {
            ID: deriveUuid('accomplishmentrecord', row.ID),
            LEGACYID: row.ID,
            USER_ID: userUuid,
            ACCOMPLISHMENT_ID: accUuid,
            AWARDEDAT: toISOTimestamp(row.DATE),
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ AccomplishmentRecords: ${e.message.split('\n')[0]}`);
    }
  }

  // 11d. PrizeRecords (user prize claims)
  // FKs: user_id → Users; prize_id → Prizes; event_id → Events;
  //      completionpathitem_id → CompletionPathItems (optional).
  // CompletionPathItems uses LEGACYID → newly-generated UUID; the
  // migrator generates a fresh UUID per row (see line 579) and never
  // builds a lookup map, so we cannot resolve this FK here. Left NULL.
  // See spec §Risk register.
  if (uuidMap.users.size > 0 && uuidMap.prizes.size > 0) {
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'prizerecords',
        sourceQuery: `SELECT "ID", "USER_ID", "EVENT_ID", "PRIZE_ID", "STATUS" FROM ${S}."IMS_PRIZE_RECORD"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_PRIZERECORDS',
        mapRow: (row) => {
          const userUuid = uuidMap.users.get(row.USER_ID);
          const prizeUuid = uuidMap.prizes.get(row.PRIZE_ID);
          if (!userUuid || !prizeUuid) return null;
          return {
            ID: deriveUuid('prizerecord', row.ID),
            LEGACYID: row.ID,
            USER_ID: userUuid,
            EVENT_ID: row.EVENT_ID ? uuidMap.events.get(row.EVENT_ID) : null,
            PRIZE_ID: prizeUuid,
            COMPLETIONPATHITEM_ID: null, // see comment above
            STATUS: truncStr(row.STATUS, 50),
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ PrizeRecords: ${e.message.split('\n')[0]}`);
    }
  }

  // 12. TutorialTags (many-to-many)
  try {
    results.push(await migrateEntity(source, target, T, {
      name: 'tutorialtags',
      sourceQuery: `SELECT "TASK_ID", "TAG_ID" FROM ${S}."IMS_TAG_TO_TASK"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS',
      mapRow: (row) => {
        const tutUuid = uuidMap.tutorials.get(row.TASK_ID);
        const tagUuid = uuidMap.tags.get(row.TAG_ID);
        if (!tutUuid || !tagUuid) return null;
        return {
          TUTORIAL_ID: tutUuid,
          TAG_ID: tagUuid,
        };
      },
    }));
  } catch (e) {
    console.log(`  ⊘ TutorialTags: ${e.message.split('\n')[0]}`);
  }

  // 13. FeaturedTasks (cross-ref for the "featured" rail at /build/catalog
  //     and the /admin-ui/#operations-display list report).
  //
  // IMS Java stored featuredOrder INTEGER inline on every IMS_TASK row
  // (Tutorial/Mission/Group share a single-table-inheritance shape with
  // a TASK_TYPE discriminator). FEATURED_ORDER > 0 means featured.
  //
  // The CAP rewrite split this into a cross-ref entity (taskLegacyId,
  // taskType, featuredOrder). The original migrator copied FEATURED_ORDER
  // into the (now-unread) Tutorials.featuredOrder column but never wrote
  // the cross-ref rows — so /build/catalog's featured rail and the admin
  // Featured Tasks tile were both empty in DEV. Caught 2026-06-22.
  try {
    results.push(await migrateEntity(source, target, T, {
      name: 'featuredtasks',
      sourceQuery: `
        SELECT "ID", "TASK_TYPE", "FEATURED_ORDER"
          FROM ${S}."IMS_TASK"
         WHERE "FEATURED_ORDER" IS NOT NULL
           AND "FEATURED_ORDER" > 0
           AND "TASK_TYPE" IN ('TUTORIAL', 'MISSION', 'GROUP')
      `,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_FEATUREDTASKS',
      mapRow: (row) => {
        // Composite key (TASK_TYPE + ID) → stable UUIDv5 namespace so reruns
        // produce the same row IDs. taskLegacyId is the IMS_TASK.id (i.e. the
        // FK back to the underlying Tutorial/Mission/Group's legacyId).
        const ID = deriveUuid('featuredtask', `${row.TASK_TYPE}:${row.ID}`);
        // legacyId is the FeaturedTasks row's OWN business ID (LegacyKeyed
        // aspect), distinct from taskLegacyId. There's no source-side legacyId
        // for a featured-task row (the curation was inline on IMS_TASK), so
        // derive a stable allocator from the first 9 hex chars of the UUID.
        // The range (1..1e9) sits well below the LegacyKeyed sequence's
        // max, and 1e9-modulo collisions across <1000 featured rows are
        // negligible. Admin self-service rows continue using getNextLegacyId.
        const legacyId = parseInt(ID.replace(/-/g, '').slice(0, 9), 16) % 1_000_000_000;
        return {
          ID,
          LEGACYID: legacyId,
          TASKLEGACYID: row.ID,
          TASKTYPE: row.TASK_TYPE,
          FEATUREDORDER: row.FEATURED_ORDER,
          CREATEDAT: new Date().toISOString(),
          MODIFIEDAT: new Date().toISOString(),
          CREATEDBY: 'migration',
          MODIFIEDBY: 'migration',
        };
      },
    }));
  } catch (e) {
    console.log(`  ⊘ FeaturedTasks: ${e.message.split('\n')[0]}`);
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Migration Summary                                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  for (const r of results) {
    if (r.skipped) continue;
    const status = r.errors ? `✓ ${r.count} (${r.errors} errors)` : `✓ ${r.count}`;
    console.log(`  ${r.name.padEnd(20)} ${status}`);
  }

  source.disconnect();
  target.disconnect();
  console.log('\nDone. Connections closed.');
}

// Only execute main() when this file is invoked directly (`node scripts/
// migrate-from-hana.js …`). When imported as a module — e.g. by the unit
// test that exercises partitionBySlug() in isolation — main() must NOT run,
// otherwise it tries to look up cf service-keys and exits the test process.
//
// Use Node's pathToFileURL() to canonicalize argv[1] into a `file://`-style
// URL that matches `import.meta.url` on every platform. The previous
// hand-rolled comparison (`file://${argv[1]}` plus `new URL(argv[1], 'file://')`)
// silently failed on Windows + Git Bash, where argv[1] arrives as a
// MinGW-translated POSIX-ish path (e.g. `C:/Program Files/Git/...`) that
// doesn't match `import.meta.url` (`file:///D:/...`). The script then
// silently exited 0 without invoking main(). Discovered 2026-06-20 mid
// re-migration session.
const _isDirectInvocation = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (_isDirectInvocation) {
  main().catch(e => {
    console.error('\n✗ Fatal error:', e.message);
    process.exit(1);
  });
}
