'use strict';
// Stage 1 of the BTP→BAIP homepage audit: read candidate rows from the bound
// (Production) DB into btp-audit/export.json. Read-only.
//
// Run: cds bind --exec -- node scripts/btp-audit/export.cjs

const fs = require('node:fs');
const path = require('node:path');
const cds = require('@sap/cds');
const { AUDIT_MAP, isCandidate, NS } = require('./fields.cjs');

const OUT_DIR = path.resolve(process.cwd(), 'btp-audit');

async function collectCandidates(db, entities) {
  const out = [];
  for (const m of AUDIT_MAP) {
    const ent = entities[m.entity];
    if (!ent) continue; // entity not in this model (defensive)
    const cols = [m.keyField, ...m.textFields];
    // Plain String columns — CDS QL SELECT is safe on both SQLite and HANA
    // (no LOBs involved, so no locator-expiry concern).
    const rows = await db.run(SELECT.from(ent).columns(...cols));
    for (const row of rows) {
      const key = row[m.keyField];
      for (const field of m.textFields) {
        const value = row[field];
        if (isCandidate(value)) out.push({ entity: m.entity, key, field, value });
      }
    }
  }
  return out;
}

async function main() {
  await cds.load('*');
  const db = await cds.connect.to('db');
  const entities = cds.entities(NS);
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  console.log(`[btp-audit:export] db kind=${db.options?.kind} hana=${isHana}`);

  const candidates = await collectCandidates(db, entities);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), count: candidates.length, candidates };
  const outFile = path.join(OUT_DIR, 'export.json');
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`[btp-audit:export] wrote ${candidates.length} candidate field(s) → ${outFile}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { collectCandidates, OUT_DIR };
