#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = process.env.MIGRATION_OUTPUT_DIR || '.migration-data';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;
const PAGE_SIZE = 500;

async function fetchPage(endpoint, page) {
  const url = `${IMS_BASE_URL}${endpoint}?page=${page}&size=${PAGE_SIZE}`;
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function getResumeState(entity) {
  const statePath = join(OUTPUT_DIR, `${entity}-state.json`);
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }
  return { lastPage: 0, totalExported: 0 };
}

function saveResumeState(entity, state) {
  const statePath = join(OUTPUT_DIR, `${entity}-state.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function exportUsers() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const entities = [
    { name: 'users', path: '/admin/Users' },
    { name: 'taskrecords', path: '/admin/TaskRecords' },
    { name: 'accomplishment-records', path: '/admin/AccomplishmentRecords' },
    { name: 'prize-records', path: '/admin/PrizeRecords' }
  ];

  for (const entity of entities) {
    console.log(`\nExporting ${entity.name}...`);
    const state = getResumeState(entity.name);
    let page = state.lastPage;
    let totalExported = state.totalExported;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await fetchPage(entity.path, page);
        const records = Array.isArray(response) ? response
          : (response.content || response.value || []);

        if (records.length === 0) {
          hasMore = false;
          break;
        }

        const batchPath = join(OUTPUT_DIR, `${entity.name}-batch-${page}.json`);
        writeFileSync(batchPath, JSON.stringify(records, null, 2));
        totalExported += records.length;
        page++;
        saveResumeState(entity.name, { lastPage: page, totalExported });
        console.log(`  Page ${page}: ${records.length} records (total: ${totalExported})`);

        if (records.length < PAGE_SIZE) hasMore = false;
      } catch (err) {
        console.error(`  ✗ Error on page ${page}: ${err.message}`);
        console.log(`  Resume from page ${page} with: node scripts/migrate-user-progress.js export`);
        break;
      }
    }

    console.log(`  → ${totalExported} total ${entity.name} exported`);
  }
}

async function importUsers() {
  const entities = ['users', 'taskrecords', 'accomplishment-records', 'prize-records'];
  const capPaths = {
    'users': '/admin/Users',
    'taskrecords': '/admin/TaskRecords',
    'accomplishment-records': '/admin/AccomplishmentRecords',
    'prize-records': '/admin/PrizeRecords'
  };

  for (const entity of entities) {
    console.log(`\nImporting ${entity}...`);
    let batch = 0;
    let totalImported = 0;
    let totalFailed = 0;

    while (true) {
      const batchPath = join(OUTPUT_DIR, `${entity}-batch-${batch}.json`);
      if (!existsSync(batchPath)) break;

      const records = JSON.parse(readFileSync(batchPath, 'utf-8'));
      for (const record of records) {
        const res = await fetch(`${CAP_BASE_URL}${capPaths[entity]}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
          },
          body: JSON.stringify(record)
        });
        if (res.ok) {
          totalImported++;
        } else {
          totalFailed++;
        }
      }
      batch++;
      process.stdout.write(`  Batch ${batch}: ${totalImported} imported\r`);
    }
    console.log(`  → ${totalImported} ${entity} imported (${totalFailed} failed)`);
  }
}

const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportUsers().catch(console.error);
} else if (mode === 'import') {
  importUsers().catch(console.error);
} else {
  console.log('Usage: node scripts/migrate-user-progress.js [export|import]');
  process.exit(1);
}
