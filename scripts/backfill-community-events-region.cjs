// scripts/backfill-community-events-region.cjs
//
// Issue #1030 — one-shot idempotent backfill.
// Populates CommunityEvents.region on any row where it's null or empty by
// running the same regionFromLocation function used at ingest. Safe to
// re-run — it only touches rows where region is unset.
//
// Usage:
//   Local (sqlite):  node scripts/backfill-community-events-region.cjs
//   Hybrid (HANA):   cds bind --exec -- node scripts/backfill-community-events-region.cjs
//
// Emits per-row action summary + final count.

const cds = require('@sap/cds');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadRegionFn() {
  // The regionFromLocation function is ESM; import via dynamic import from CJS.
  const url = pathToFileURL(path.resolve(__dirname, '..', 'srv', 'lib', 'events', 'region-from-location.js')).href;
  const mod = await import(url);
  return mod.regionFromLocation;
}

async function main() {
  const regionFromLocation = await loadRegionFn();

  // Load the CDS model so `cds.entities(...)` is callable. The serving
  // lifecycle does this for you; `cds bind --exec` does not. See #757 / #911.
  cds.model = cds.linked(await cds.load('*'));
  void cds.model.entities;
  const db = await cds.connect.to('db');

  // On local SQLite (kind=sqlite) the schema is not yet deployed — deploy it
  // so SELECT works. On HANA (kind=hana) the schema is already deployed by HDI;
  // skip this step entirely.
  if (db.options?.kind === 'sqlite') {
    await cds.deploy(cds.model).to(db);
  }

  const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');

  const rows = await SELECT.from(CommunityEvents)
    .columns('ID', 'location', 'region')
    .where`region is null or region = ''`;

  console.log(`[backfill] ${rows.length} rows to update`);

  let updated = 0, unknown = 0;
  for (const row of rows) {
    const region = regionFromLocation(row.location);
    if (region === 'UNKNOWN') unknown++;
    await UPDATE(CommunityEvents).set({ region }).where({ ID: row.ID });
    updated++;
    if (updated % 50 === 0) console.log(`[backfill] progress: ${updated}/${rows.length}`);
  }
  console.log(`[backfill] complete: updated=${updated}, unknown=${unknown}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
