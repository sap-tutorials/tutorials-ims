#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = '.comparison-results';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;

const COMPARISON_ENDPOINTS = [
  { name: 'tutorials-list', ims: '/api/tutorials', cap: '/api/Tutorials' },
  { name: 'missions-list', ims: '/api/missions', cap: '/api/Missions?$select=legacyId,title,status' },
  { name: 'events-list', ims: '/api/events', cap: '/admin/Events' },
  { name: 'tags-list', ims: '/api/tags', cap: '/admin/Tags' }
];

async function fetchEndpoint(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) return { error: `${res.status} ${res.statusText}`, url };
  return res.json();
}

function normalizeForComparison(data) {
  const records = Array.isArray(data) ? data
    : (data.value || data.content || data._embedded?.items || []);
  return records.map(r => {
    const normalized = {};
    const keys = Object.keys(r).filter(k =>
      !k.startsWith('_') && !k.startsWith('@') &&
      !['ID', 'createdAt', 'modifiedAt', 'createdBy', 'modifiedBy'].includes(k)
    ).sort();
    for (const key of keys) normalized[key] = r[key];
    return normalized;
  }).sort((a, b) => (a.legacyId || 0) - (b.legacyId || 0));
}

function diffRecords(imsRecords, capRecords) {
  const diffs = [];
  const imsMap = new Map(imsRecords.map(r => [r.legacyId, r]));
  const capMap = new Map(capRecords.map(r => [r.legacyId, r]));

  for (const [id, imsRec] of imsMap) {
    const capRec = capMap.get(id);
    if (!capRec) {
      diffs.push({ type: 'missing_in_cap', legacyId: id });
    } else {
      const fieldDiffs = [];
      for (const key of Object.keys(imsRec)) {
        if (JSON.stringify(imsRec[key]) !== JSON.stringify(capRec[key])) {
          fieldDiffs.push({ field: key, ims: imsRec[key], cap: capRec[key] });
        }
      }
      if (fieldDiffs.length > 0) {
        diffs.push({ type: 'field_mismatch', legacyId: id, fields: fieldDiffs });
      }
    }
  }

  for (const [id] of capMap) {
    if (!imsMap.has(id)) {
      diffs.push({ type: 'extra_in_cap', legacyId: id });
    }
  }

  return diffs;
}

async function runComparisons() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Comparing: ${IMS_URL} ↔ ${CAP_URL}\n`);

  const results = [];

  for (const endpoint of COMPARISON_ENDPOINTS) {
    console.log(`${endpoint.name}...`);
    const [imsData, capData] = await Promise.all([
      fetchEndpoint(IMS_URL, endpoint.ims),
      fetchEndpoint(CAP_URL, endpoint.cap)
    ]);

    if (imsData.error || capData.error) {
      const result = { endpoint: endpoint.name, status: 'ERROR', imsError: imsData.error, capError: capData.error };
      results.push(result);
      console.log(`  ✗ Error: IMS=${imsData.error || 'OK'}, CAP=${capData.error || 'OK'}`);
      continue;
    }

    const imsNormalized = normalizeForComparison(imsData);
    const capNormalized = normalizeForComparison(capData);
    const diffs = diffRecords(imsNormalized, capNormalized);

    const result = {
      endpoint: endpoint.name,
      status: diffs.length === 0 ? 'MATCH' : 'DIFF',
      imsCount: imsNormalized.length,
      capCount: capNormalized.length,
      diffs: diffs.slice(0, 20)
    };
    results.push(result);

    if (diffs.length === 0) {
      console.log(`  ✓ Match (${imsNormalized.length} records)`);
    } else {
      console.log(`  ✗ ${diffs.length} differences (IMS: ${imsNormalized.length}, CAP: ${capNormalized.length})`);
    }
  }

  const reportPath = join(OUTPUT_DIR, `comparison-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nReport saved to ${reportPath}`);

  const failed = results.filter(r => r.status !== 'MATCH');
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} endpoints have differences.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} endpoints match.`);
  }
}

runComparisons().catch(err => {
  console.error('Comparison failed:', err.message);
  process.exit(1);
});
