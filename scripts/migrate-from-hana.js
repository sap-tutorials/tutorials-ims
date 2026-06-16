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

function query(client, sql, params = []) {
  return new Promise((resolve, reject) => {
    client.exec(sql, params, (err, rows) => {
      if (err) reject(new Error(`SQL error: ${err.message}\n  SQL: ${sql}`));
      else resolve(rows);
    });
  });
}

function execStmt(client, sql, params = []) {
  return new Promise((resolve, reject) => {
    client.exec(sql, params, (err, result) => {
      if (err) reject(new Error(`SQL error: ${err.message}\n  SQL: ${sql.slice(0, 200)}`));
      else resolve(result);
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

async function migrateEntity(source, target, targetSchema, config) {
  const { name, sourceQuery, targetTable, mapRow, preInsert } = config;

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
  if (!DRY_RUN) {
    const existing = await query(target, `SELECT COUNT(*) AS "C" FROM ${fullTable}`);
    if (existing[0].C > 0) {
      console.log(`  Clearing ${existing[0].C} existing records in target...`);
      await execStmt(target, `DELETE FROM ${fullTable}`);
    }
  }

  // Map all rows and filter nulls
  const mapped = [];
  for (const row of rows) {
    const m = mapRow(row);
    if (m) mapped.push(m);
  }

  if (DRY_RUN) {
    mapped.slice(0, 3).forEach(m => console.log(`  [dry-run] Would insert:`, JSON.stringify(m).slice(0, 200)));
    console.log(`  ✓ ${mapped.length} inserted, 0 errors`);
    return { name, count: mapped.length };
  }

  // Prepare INSERT statement using named parameters from first row's keys
  const cols = Object.keys(mapped[0]);
  const colNames = cols.map(c => `"${c}"`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const insertSQL = `INSERT INTO ${fullTable} (${colNames}) VALUES (${placeholders})`;
  const stmt = await prepare(target, insertSQL);

  let inserted = 0;
  let errors = 0;

  // Execute in batches
  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const batch = mapped.slice(i, i + BATCH_SIZE);
    // Convert objects to arrays of values in column order
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
  console.log(`  ✓ ${inserted} inserted, ${errors} errors`);
  return { name, count: inserted, errors };
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

  // Step parent mapping: step ID → { parentId (tutorial), order }
  const stepParentMap = new Map();
  try {
    const parents = await query(source, `SELECT "CHILD_TASK_ID", "PARENT_TASK_ID", "TASK_ORDER" FROM ${S}."IMS_TASK_TO_PARENT"`);
    parents.forEach(p => stepParentMap.set(p.CHILD_TASK_ID, { parentId: p.PARENT_TASK_ID, order: p.TASK_ORDER }));
    console.log(`  Task-to-parent links: ${stepParentMap.size}`);
  } catch (e) { /* optional */ }

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

  // 1. Tags
  results.push(await migrateEntity(source, target, T, {
    name: 'tags',
    sourceQuery: `SELECT "ID", "NAME" FROM ${S}."IMS_TAG"`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_TAGS',
    mapRow: (row) => ({
      ID: uuidMap.tags.get(row.ID),
      LEGACYID: row.ID,
      NAME: truncStr(row.NAME, 255),
    }),
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
      STATUS: truncStr(row.TASK_STATUS, 50),
      CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
      MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
      CREATEDBY: truncStr(row.CREATED_BY, 255) || 'migration',
      MODIFIEDBY: truncStr(row.UPDATED_BY, 255) || 'migration',
    }),
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
        STATUS: truncStr(row.TASK_STATUS, 50),
        GROUP_ID: groupLegacyId ? uuidMap.groups.get(groupLegacyId) : null,
        CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
        MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
        CREATEDBY: truncStr(row.CREATED_BY, 255) || 'migration',
        MODIFIEDBY: truncStr(row.UPDATED_BY, 255) || 'migration',
      };
    },
  }));

  // 5. Tutorials
  results.push(await migrateEntity(source, target, T, {
    name: 'tutorials',
    sourceQuery: `SELECT "ID", "TITLE", "TASK_STATUS", "URL", "PRIMARY_TAG_ID", "EXPERIENCE_TAG_ID", "AVERAGE_TTC", "FEATURED_ORDER", "CREATED_AT", "UPDATED_AT", "CREATED_BY", "UPDATED_BY" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'TUTORIAL'`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALS',
    mapRow: (row) => ({
      ID: uuidMap.tutorials.get(row.ID),
      LEGACYID: row.ID,
      TITLE: truncStr(row.TITLE, 255),
      STATUS: truncStr(row.TASK_STATUS, 50),
      // IMS source stores tutorial slugs as the markdown filename
      // (e.g. "abap-environment-maintain-bc-app.md"). Hugo serves
      // tutorials at /tutorials/<slug-without-md>, and /build/catalog
      // emits whatever's in the SLUG column verbatim. Without this
      // strip, Hugo's tutorial cache (keyed off the .md-less slug)
      // never matches the catalog mappings, so the navigator emits
      // 0 mission/group cards. Surfaced 2026-06-16 cutover rehearsal.
      SLUG: truncStr(((row.URL || '').split('/').pop() || `tutorial-${row.ID}`).replace(/\.md$/i, ''), 255),
      MDFILEURL: truncStr(row.URL, 1000),
      PRIMARYTAG: truncStr(tagMap.get(row.PRIMARY_TAG_ID), 255) || null,
      EXPERIENCETAG: truncStr(tagMap.get(row.EXPERIENCE_TAG_ID), 255) || null,
      AVERAGETIMETOCOMPLETE: row.AVERAGE_TTC,
      FEATUREDORDER: row.FEATURED_ORDER,
      CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
      MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
      CREATEDBY: truncStr(row.CREATED_BY, 255) || 'migration',
      MODIFIEDBY: truncStr(row.UPDATED_BY, 255) || 'migration',
    }),
  }));

  // 6. Steps
  results.push(await migrateEntity(source, target, T, {
    name: 'steps',
    sourceQuery: `SELECT "ID", "TITLE", "TASK_STATUS", "CREATED_AT", "UPDATED_AT" FROM ${S}."IMS_TASK" WHERE "TASK_TYPE" = 'STEP'`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_STEPS',
    mapRow: (row) => {
      const parent = stepParentMap.get(row.ID);
      const tutorialUuid = parent ? uuidMap.tutorials.get(parent.parentId) : null;
      return {
        ID: uuidMap.steps.get(row.ID),
        LEGACYID: row.ID,
        TITLE: truncStr(row.TITLE, 255),
        STATUS: truncStr(row.TASK_STATUS, 50),
        TUTORIAL_ID: tutorialUuid,
        STEPORDER: parent?.order ?? 0,
        CREATEDAT: toISOTimestamp(row.CREATED_AT) || new Date().toISOString(),
        MODIFIEDAT: toISOTimestamp(row.UPDATED_AT) || new Date().toISOString(),
        CREATEDBY: 'migration',
        MODIFIEDBY: 'migration',
      };
    },
  }));

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

  // 7b. UserMetaData — INTENTIONALLY NOT MIGRATED.
  // The CAP UserMetaData entity (db/schema.cds:127-131) models a per-user
  // key/value store. The IMS source IMS_USER_META_DATA is a visitor-ID
  // tracking table with completely different columns (USER_ID, VISITOR_ID,
  // CREATED_BY, UPDATED_BY, CREATED_AT, UPDATED_AT — no ID/KEY/VALUE).
  // The CDS entity is a v2 design IMS never used; nothing to migrate.
  // See issue #330. Caught during 2026-06-15 cutover-rehearsal dry-run.

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
    results.push(await migrateEntity(source, target, T, {
      name: 'completionpaths',
      sourceQuery: `SELECT "ID", "MISSION_ID", "TITLE", "DESCRIPTION", "PATH_ORDER" FROM ${S}."IMS_COMPLETION_PATH"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS',
      mapRow: (row) => ({
        ID: uuidMap.completionPaths.get(row.ID),
        LEGACYID: row.ID,
        MISSION_ID: uuidMap.missions.get(row.MISSION_ID) || null,
        NAME: truncStr(row.TITLE, 255),
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

main().catch(e => {
  console.error('\n✗ Fatal error:', e.message);
  process.exit(1);
});
