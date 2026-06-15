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
import { randomUUID } from 'crypto';
import hdb from 'hdb';

const DRY_RUN = process.argv.includes('--dry-run');
const DISCOVER = process.argv.includes('--discover');
const SOURCE_ONLY = process.argv.includes('--source-only');
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  IMS HANA → CAP HANA Direct Migration               ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  ⚠ DRY RUN MODE — no data will be written');
  if (DISCOVER) console.log('  ⚠ DISCOVER MODE — listing tables only');
  console.log('');

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
    const uuid = randomUUID();
    const type = (t.TASK_TYPE || '').toLowerCase();
    if (type === 'tutorial') uuidMap.tutorials.set(t.ID, uuid);
    else if (type === 'mission') uuidMap.missions.set(t.ID, uuid);
    else if (type === 'group') uuidMap.groups.set(t.ID, uuid);
    else if (type === 'step') uuidMap.steps.set(t.ID, uuid);
  }
  console.log(`  Tasks: ${allTasks.length} (tutorials: ${uuidMap.tutorials.size}, missions: ${uuidMap.missions.size}, groups: ${uuidMap.groups.size}, steps: ${uuidMap.steps.size})`);

  const allUsers = await query(source, `SELECT "ID" FROM ${S}."IMS_USER"`);
  allUsers.forEach(u => uuidMap.users.set(u.ID, randomUUID()));
  console.log(`  Users: ${uuidMap.users.size}`);

  const allEvents = await query(source, `SELECT "ID" FROM ${S}."IMS_EVENT"`);
  allEvents.forEach(e => uuidMap.events.set(e.ID, randomUUID()));
  console.log(`  Events: ${uuidMap.events.size}`);

  let allTags = [];
  try {
    allTags = await query(source, `SELECT "ID" FROM ${S}."IMS_TAG"`);
    allTags.forEach(t => uuidMap.tags.set(t.ID, randomUUID()));
    console.log(`  Tags (entities): ${uuidMap.tags.size}`);
  } catch (e) { /* table might not exist */ }

  let hasCompletionPaths = false;
  try {
    const cpCount = await query(source, `SELECT COUNT(*) AS "C" FROM ${S}."IMS_COMPLETION_PATH"`);
    hasCompletionPaths = cpCount[0].C > 0;
    if (hasCompletionPaths) {
      const cps = await query(source, `SELECT "ID" FROM ${S}."IMS_COMPLETION_PATH"`);
      cps.forEach(cp => uuidMap.completionPaths.set(cp.ID, randomUUID()));
      console.log(`  CompletionPaths: ${uuidMap.completionPaths.size}`);
    }
  } catch (e) { /* optional table */ }

  try {
    const prizes = await query(source, `SELECT "ID" FROM ${S}."IMS_PRIZE"`);
    prizes.forEach(p => uuidMap.prizes.set(p.ID, randomUUID()));
    console.log(`  Prizes: ${uuidMap.prizes.size}`);
  } catch (e) { /* optional table */ }

  try {
    const accs = await query(source, `SELECT "ID" FROM ${S}."IMS_ACCOMPLISHMENT"`);
    accs.forEach(a => uuidMap.accomplishments.set(a.ID, randomUUID()));
    console.log(`  Accomplishments: ${uuidMap.accomplishments.size}`);
  } catch (e) { /* optional table */ }

  // Step parent mapping: step ID → { parentId (tutorial), order }
  const stepParentMap = new Map();
  try {
    const parents = await query(source, `SELECT "CHILD_TASK_ID", "PARENT_TASK_ID", "TASK_ORDER" FROM ${S}."IMS_TASK_TO_PARENT"`);
    parents.forEach(p => stepParentMap.set(p.CHILD_TASK_ID, { parentId: p.PARENT_TASK_ID, order: p.TASK_ORDER }));
    console.log(`  Task-to-parent links: ${stepParentMap.size}`);
  } catch (e) { /* optional */ }

  // Mission-to-group mapping
  const missionGroupMap = new Map();
  try {
    const missionGroups = await query(source, `
      SELECT ttp."CHILD_TASK_ID" AS "MISSION_ID", ttp."PARENT_TASK_ID" AS "GROUP_ID"
      FROM ${S}."IMS_TASK_TO_PARENT" ttp
      JOIN ${S}."IMS_TASK" t ON t."ID" = ttp."CHILD_TASK_ID" AND t."TASK_TYPE" = 'MISSION'
      JOIN ${S}."IMS_TASK" g ON g."ID" = ttp."PARENT_TASK_ID" AND g."TASK_TYPE" = 'GROUP'
    `);
    missionGroups.forEach(mg => missionGroupMap.set(mg.MISSION_ID, mg.GROUP_ID));
    console.log(`  Mission-to-group links: ${missionGroupMap.size}`);
  } catch (e) { /* optional */ }

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
      SLUG: truncStr((row.URL || '').split('/').pop() || `tutorial-${row.ID}`, 255),
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

  // 7b. UserMetaData (CAP entity: UserMetaData)
  // FK: user_id → Users. Insert after Users so the FK resolves.
  // Defensive: IMS prod may not have this table populated.
  // HANA column for `key` is "KEY" (uppercase) per db/last-dev/csn.json.
  try {
    results.push(await migrateEntity(source, target, T, {
      name: 'usermetadata',
      sourceQuery: `SELECT "ID", "USER_ID", "KEY", "VALUE" FROM ${S}."IMS_USER_METADATA"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_USERMETADATA',
      mapRow: (row) => {
        const userUuid = uuidMap.users.get(row.USER_ID);
        if (!userUuid) return null; // orphan: no migrated user → drop row
        return {
          ID: randomUUID(),
          LEGACYID: row.ID,
          USER_ID: userUuid,
          KEY: truncStr(row.KEY, 255),
          VALUE: truncStr(row.VALUE, 2000),
        };
      },
    }));
  } catch (e) {
    console.log(`  ⊘ UserMetaData: ${e.message.split('\n')[0]}`);
  }

  // 8. Task Records
  results.push(await migrateEntity(source, target, T, {
    name: 'taskrecords',
    sourceQuery: `SELECT "ID", "USER_ID", "TASK_ID", "EVENT_ID", "TASK_TYPE", "STATUS", "COMPLETION_TIME", "PROGRESS", "CONTENT_LANGUAGE", "SITE_LANGUAGE", "SUBMISSION_ID_STARTED", "SUBMISSION_ID_COMPLETED", "CREATED_AT", "UPDATED_AT" FROM ${S}."IMS_TASK_RECORD"`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_TASKRECORDS',
    mapRow: (row) => ({
      ID: randomUUID(),
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
          let taskType = null;
          if (uuidMap.tutorials.has(row.TASK_ID)) taskType = 'TUTORIAL';
          else if (uuidMap.missions.has(row.TASK_ID)) taskType = 'MISSION';
          else if (uuidMap.groups.has(row.TASK_ID)) taskType = 'GROUP';

          return {
            ID: randomUUID(),
            LEGACYID: row.ID,
            PATH_ID: uuidMap.completionPaths.get(row.PATH_ID) || null,
            TASKLEGACYID: row.TASK_ID,
            TASKTYPE: taskType,
            ITEMORDER: row.COMPLETION_PATH_ORDER,
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ Completion path items: ${e.message.split('\n')[0]}`);
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
        sourceQuery: `SELECT "ID", "NAME", "RULE", "DESCRIPTION" FROM ${S}."IMS_ACCOMPLISHMENT"`,
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
