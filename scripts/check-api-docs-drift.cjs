#!/usr/bin/env node
// scripts/check-api-docs-drift.cjs
//
// #1040 follow-up. Enforces that every row in hugo/data/api_endpoints.yaml
// is also documented in docs/developers/operations/testing-endpoints.md —
// so the public /api-docs/ landing page can't quietly drift out of sync
// with the internal canonical inventory.
//
// Rules per row:
//   - `skipDrift: true`             → skipped entirely
//   - `driftMarkers: [str, ...]`    → every marker must appear verbatim
//                                      in testing-endpoints.md
//   - otherwise                     → the row's `path` must appear verbatim
//
// Substring match. testing-endpoints.md is intentionally broader than the
// public YAML, so the check is one-way (YAML ⊆ doc).
//
// Wired into CI on any PR that touches either file
// (.github/workflows/api-docs-drift.yml). Run locally:
//
//   npm run check:api-docs-drift

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const YAML_PATH = path.join(REPO_ROOT, 'hugo', 'data', 'api_endpoints.yaml');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'developers', 'operations', 'testing-endpoints.md');

/**
 * @param {object} data   Parsed api_endpoints.yaml
 * @param {string} docSrc Raw contents of testing-endpoints.md
 * @returns {{ok: boolean, missing: Array<{section: string, path: string, marker: string}>, checked: number}}
 */
function checkApiDocsDrift(data, docSrc) {
  const missing = [];
  let checked = 0;
  const sections = (data && data.sections) || {};
  for (const [sectionName, section] of Object.entries(sections)) {
    const rows = Array.isArray(section && section.rows) ? section.rows : [];
    for (const row of rows) {
      if (row.skipDrift) continue;
      checked++;
      const markers = Array.isArray(row.driftMarkers) && row.driftMarkers.length
        ? row.driftMarkers
        : [row.path];
      for (const marker of markers) {
        if (typeof marker !== 'string' || marker.length === 0) {
          missing.push({ section: sectionName, path: row.path || '(missing path)', marker: '(empty marker)' });
          continue;
        }
        if (!docSrc.includes(marker)) {
          missing.push({ section: sectionName, path: row.path || '(missing path)', marker });
        }
      }
    }
  }
  return { ok: missing.length === 0, missing, checked };
}

function main() {
  if (!fs.existsSync(YAML_PATH)) {
    console.error(`check-api-docs-drift: YAML not found at ${YAML_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(DOC_PATH)) {
    console.error(`check-api-docs-drift: doc not found at ${DOC_PATH}`);
    process.exit(1);
  }
  let data;
  try {
    // js-yaml v4+: yaml.load() is the safe loader by default (the old
    // unsafe yaml.safeLoad shim was deprecated; there is no !!python
    // tag risk in this JS library). Matches scripts/validate-api-docs-yaml.cjs.
    data = yaml.load(fs.readFileSync(YAML_PATH, 'utf8'));
  } catch (err) {
    console.error(`check-api-docs-drift: failed to parse ${YAML_PATH}: ${err.message}`);
    process.exit(1);
  }
  const docSrc = fs.readFileSync(DOC_PATH, 'utf8');
  const { ok, missing, checked } = checkApiDocsDrift(data, docSrc);
  if (ok) {
    console.log(`check-api-docs-drift: OK (${checked} rows checked)`);
    process.exit(0);
  }
  console.error(`check-api-docs-drift: ${missing.length} row(s) missing from testing-endpoints.md:`);
  for (const m of missing) {
    console.error(`  [${m.section}] path=${m.path}  missing marker: ${m.marker}`);
  }
  console.error('');
  console.error('Fix by either:');
  console.error(`  (a) adding the missing marker(s) to ${path.relative(REPO_ROOT, DOC_PATH)},`);
  console.error('  (b) tightening driftMarkers on the row to point at a string that IS in the doc, or');
  console.error('  (c) if this row is intentionally page-only (schema URLs, external endpoints, etc.),');
  console.error('      tagging it `skipDrift: true` with a comment explaining why.');
  process.exit(2);
}

module.exports = { checkApiDocsDrift };

if (require.main === module) main();
