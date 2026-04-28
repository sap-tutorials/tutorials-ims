#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = process.env.MIGRATION_OUTPUT_DIR || '.migration-data';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;

const ENTITY_ENDPOINTS = [
  { name: 'tutorials', path: '/api/tutorials', capEntity: 'Tutorials' },
  { name: 'missions', path: '/api/missions', capEntity: 'Missions' },
  { name: 'groups', path: '/api/groups', capEntity: 'Groups' },
  { name: 'events', path: '/api/events', capEntity: 'Events' },
  { name: 'accomplishments', path: '/api/accomplishments', capEntity: 'Accomplishments' },
  { name: 'tags', path: '/api/tags', capEntity: 'Tags' },
  { name: 'prizes', path: '/api/prizes', capEntity: 'Prizes' }
];

async function fetchFromIms(endpoint) {
  const url = `${IMS_BASE_URL}${endpoint}`;
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

function transformRecord(record, entityName) {
  const mapped = { ...record };
  if (record.id && !record.legacyId) {
    mapped.legacyId = record.id;
    delete mapped.id;
  }
  delete mapped._links;
  delete mapped._embedded;
  return mapped;
}

async function exportData() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const entity of ENTITY_ENDPOINTS) {
    console.log(`Exporting ${entity.name}...`);
    try {
      const data = await fetchFromIms(entity.path);
      const records = Array.isArray(data) ? data : (data.content || data._embedded?.[entity.name] || []);
      const transformed = records.map(r => transformRecord(r, entity.name));
      const outPath = join(OUTPUT_DIR, `${entity.name}.json`);
      writeFileSync(outPath, JSON.stringify(transformed, null, 2));
      console.log(`  → ${transformed.length} records saved to ${outPath}`);
    } catch (err) {
      console.error(`  ✗ Failed to export ${entity.name}: ${err.message}`);
    }
  }
}

async function importData() {
  for (const entity of ENTITY_ENDPOINTS) {
    const filePath = join(OUTPUT_DIR, `${entity.name}.json`);
    if (!existsSync(filePath)) {
      console.log(`Skipping ${entity.name} — no export file found`);
      continue;
    }

    const records = JSON.parse(readFileSync(filePath, 'utf-8'));
    console.log(`Importing ${records.length} ${entity.name}...`);

    let imported = 0;
    let failed = 0;
    for (const record of records) {
      const res = await fetch(`${CAP_BASE_URL}/admin/${entity.capEntity}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
        },
        body: JSON.stringify(record)
      });
      if (res.ok) {
        imported++;
      } else {
        failed++;
        if (failed <= 5) console.error(`  ✗ Record ${record.legacyId || '?'}: ${res.status}`);
      }
      if ((imported + failed) % 100 === 0) {
        process.stdout.write(`  ${imported + failed}/${records.length}\r`);
      }
    }
    console.log(`  → ${imported}/${records.length} imported (${failed} failed)`);
  }
}

const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportData().catch(console.error);
} else if (mode === 'import') {
  importData().catch(console.error);
} else {
  console.log('Usage: node scripts/migrate-reference-data.js [export|import]');
  console.log('  export — Fetch from Java IMS and save as JSON');
  console.log('  import — Load JSON into CAP system');
  process.exit(1);
}
