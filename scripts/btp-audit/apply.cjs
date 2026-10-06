'use strict';
// Stage 3 of the BTP→BAIP homepage audit: apply the approved changeset to the
// bound (Production) DB. Dry-run by default; --commit to write. Guards:
// prod cf-target check, optimistic concurrency (value must still equal oldValue).
//
// Run (preview): cds bind --exec -- node scripts/btp-audit/apply.cjs
// Run (write):   cds bind --exec -- node scripts/btp-audit/apply.cjs --commit

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const cds = require('@sap/cds');
const { AUDIT_MAP, NS } = require('./fields.cjs');
const { decideApply, assertProdTarget } = require('./apply-core.cjs');
const { OUT_DIR } = require('./export.cjs');

const META = Object.fromEntries(AUDIT_MAP.map(m => [m.entity, m]));

async function readCurrent(db, entities, meta, key) {
  // Single-column reads; plain Strings (no LOBs) so CDS QL is safe on both engines.
  const row = await db.run(
    SELECT.one.from(entities[meta.entity]).where({ [meta.keyField]: key }));
  return row || null;
}

async function writeValue(db, entities, meta, key, field, newValue) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    // Raw parameterized SQL — identifiers come from the fixed in-code map (never data),
    // values are bound via ? placeholders (CLAUDE.md: no SQL string concat of values).
    const sql = `UPDATE ${meta.hanaTable} SET "${field.toUpperCase()}" = ? ` +
                `WHERE "${meta.hanaKeyCol}" = ?`;
    await db.run(sql, [newValue, key]);
  } else {
    await db.run(UPDATE(entities[meta.entity]).set({ [field]: newValue })
      .where({ [meta.keyField]: key }));
  }
}

async function applyChangeset(db, entities, records, opts) {
  const commit = !!(opts && opts.commit);
  const log = [];
  for (const r of records) {
    const meta = META[r.entity];
    if (!meta) { log.push({ ...pick(r), status: 'skipped-unknown-entity' }); continue; }
    const row = await readCurrent(db, entities, meta, r.key);
    if (!row) { log.push({ ...pick(r), status: 'skipped-missing-row' }); continue; }
    // Whitelist the field name against the fixed AUDIT_MAP so the HANA SQL
    // identifier is provably from code, not from changeset.json data.
    if (!meta.textFields.includes(r.field)) {
      log.push({ ...pick(r), status: 'skipped-invalid-field' }); continue;
    }
    const currentValue = row[r.field];
    const { status, write } = decideApply(r, currentValue);
    if (write && commit) {
      await writeValue(db, entities, meta, r.key, r.field, r.newValue);
      log.push({ ...pick(r), status: 'applied' });
    } else if (write && !commit) {
      log.push({ ...pick(r), status: 'would-apply' });
    } else {
      log.push({ ...pick(r), status });
    }
  }
  return log;
}

function pick(r) {
  return { entity: r.entity, key: r.key, field: r.field,
    oldValue: r.oldValue, newValue: r.newValue, action: r.action };
}

async function main() {
  const commit = process.argv.includes('--commit');
  await cds.load('*');
  const db = await cds.connect.to('db');
  const entities = cds.entities(NS);
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (commit && isHana) {
    const target = execSync('cf target', { encoding: 'utf8' });
    assertProdTarget(target); // throws → aborts before any write
    console.log('[btp-audit:apply] prod target confirmed; committing.');
  } else if (commit && !isHana) {
    console.log('[btp-audit:apply] --commit on non-HANA db (local); skipping cf target guard.');
  } else {
    console.log('[btp-audit:apply] DRY RUN (no --commit). No rows will be written.');
  }

  const { records } = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'changeset.json'), 'utf8'));
  const log = await applyChangeset(db, entities, records, { commit });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'applied.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), commit, log }, null, 2));
  const counts = log.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  console.log('[btp-audit:apply] result:', counts);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { applyChangeset };
