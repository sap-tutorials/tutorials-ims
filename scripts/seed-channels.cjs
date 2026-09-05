'use strict';
// Idempotent re-ingest of the external-channels research dataset into Channels.
// Preserves admin-curated columns; retires-on-absence (soft). Run:
//   npx cds bind --exec -- node scripts/seed-channels.cjs --file d:/tmp/External-SAP-Channels-Complete.json --commit
const cds = require('@sap/cds');
const { readFileSync } = require('node:fs');
const { normalizeChannel } = require('../srv/lib/channels/normalize.cjs');

const CURATED = ['isPublished', 'isFeatured', 'editorialNote', 'linkStatus', 'linkStatusOverride', 'lastChecked'];

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : 'd:/tmp/External-SAP-Channels-Complete.json';

  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const batch = doc.metadata?.generated ?? new Date().toISOString().slice(0, 10);
  const rawChannels = doc.channels ?? doc;

  const db = await cds.connect.to('db');
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels } = linked.entities('com.sap.developers.ims');

  let inserted = 0, updated = 0, skipped = 0;
  const seen = new Set();
  for (const raw of rawChannels) {
    const row = normalizeChannel(raw, batch);
    seen.add(row.sourceId);
    const existing = await SELECT.one.from(Channels).where({ sourceId: row.sourceId });
    if (existing && existing.contentHash === row.contentHash && !force) { skipped++; continue; }
    if (existing) {
      // update source-owned fields only; never touch curated columns
      const patch = { ...row };
      for (const k of CURATED) delete patch[k];
      if (commit) await UPDATE(Channels).set(patch).where({ ID: existing.ID });
      updated++;
    } else {
      if (commit) await INSERT.into(Channels).entries({ ID: cds.utils.uuid(), ...row });
      inserted++;
    }
  }

  // retire-on-absence (soft): rows never seen in this batch → Archived, curation untouched
  const all = await SELECT.from(Channels).columns('ID', 'sourceId', 'status');
  let retired = 0;
  for (const r of all) {
    if (!seen.has(r.sourceId) && r.status !== 'Archived') {
      if (commit) await UPDATE(Channels).set({ status: 'Archived' }).where({ ID: r.ID });
      retired++;
    }
  }

  console.log(`[seed-channels] batch=${batch} ${commit ? 'COMMIT' : 'DRY-RUN'} `
    + `inserted=${inserted} updated=${updated} skipped=${skipped} retired=${retired}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
