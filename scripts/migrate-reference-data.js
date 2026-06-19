#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = process.env.MIGRATION_OUTPUT_DIR || '.migration-data';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;
const CAP_CACHE_FILE = '.tutorial-cache/cap-catalog.json';

function loadCatalogSlugs() {
  const missions = new Map();
  const paths = new Map();

  if (!existsSync(CAP_CACHE_FILE)) {
    console.log('  [slug] No CAP catalog cache found — slugs will not be populated');
    return { missions, paths };
  }

  const cache = JSON.parse(readFileSync(CAP_CACHE_FILE, 'utf-8'));

  for (const m of cache.missions || []) {
    if (m.imsId && m.slug) missions.set(m.imsId, m.slug);
  }

  for (const h of cache.hierarchies || []) {
    for (const g of h.groups || []) {
      if (g.imsId && g.slug) paths.set(g.imsId, g.slug);
    }
  }

  console.log(`  [slug] Loaded ${missions.size} mission slugs, ${paths.size} group/path slugs from CAP catalog cache`);
  return { missions, paths };
}

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
  const catalogSlugs = loadCatalogSlugs();

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
      if (entity.name === 'missions' && catalogSlugs.missions.has(record.legacyId)) {
        record.slug = catalogSlugs.missions.get(record.legacyId);
      }
      const res = await fetch(`${CAP_BASE_URL}/admin/${entity.capEntity}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-migration-mode': 'true',
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
} else if (mode === 'populate-slugs') {
  populateSlugs().catch(console.error);
} else {
  console.log('Usage: node scripts/migrate-reference-data.js [export|import|populate-slugs]');
  console.log('  export          — Fetch from Java IMS and save as JSON');
  console.log('  import          — Load JSON into CAP system');
  console.log('  populate-slugs  — Patch slug fields from AEM cache into CAP');
  process.exit(1);
}

async function populateSlugs() {
  const { missions, paths } = loadCatalogSlugs();
  if (missions.size === 0 && paths.size === 0) {
    console.error('No slug data available. Ensure .tutorial-cache/aem-missions.json exists.');
    console.error('Run "npm run fetch-tutorials -- --force-aem" to generate it.');
    process.exit(1);
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-migration-mode': 'true',
    ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
  };

  console.log(`Patching ${missions.size} mission slugs...`);
  let patched = 0;
  let skipped = 0;
  for (const [legacyId, slug] of missions) {
    const query = await fetch(`${CAP_BASE_URL}/admin/Missions?$filter=legacyId eq ${legacyId}&$select=ID,slug`, { headers });
    if (!query.ok) { skipped++; continue; }
    const { value } = await query.json();
    if (!value || value.length === 0) { skipped++; continue; }
    const record = value[0];
    if (record.slug === slug) { skipped++; continue; }

    const patch = await fetch(`${CAP_BASE_URL}/admin/Missions(${record.ID})`, {
      method: 'PATCH', headers, body: JSON.stringify({ slug })
    });
    if (patch.ok) patched++;
    else skipped++;
  }
  console.log(`  → ${patched} missions patched, ${skipped} skipped`);

  console.log(`Patching ${paths.size} completion path slugs...`);
  patched = 0;
  skipped = 0;
  for (const [legacyId, slug] of paths) {
    const query = await fetch(`${CAP_BASE_URL}/admin/CompletionPaths?$filter=legacyId eq ${legacyId}&$select=ID,slug`, { headers });
    if (!query.ok) { skipped++; continue; }
    const { value } = await query.json();
    if (!value || value.length === 0) { skipped++; continue; }
    const record = value[0];
    if (record.slug === slug) { skipped++; continue; }

    const patch = await fetch(`${CAP_BASE_URL}/admin/CompletionPaths(${record.ID})`, {
      method: 'PATCH', headers, body: JSON.stringify({ slug })
    });
    if (patch.ok) patched++;
    else skipped++;
  }
  console.log(`  → ${patched} paths patched, ${skipped} skipped`);
  console.log('Done.');
}
