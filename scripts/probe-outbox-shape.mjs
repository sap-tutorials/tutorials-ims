// scripts/probe-outbox-shape.mjs
//
// #1021: One-shot probe to confirm cds.outbox.Messages field names at
// runtime. Run against local SQLite (default) or hybrid HANA (with
// `cds bind --exec -- node scripts/probe-outbox-shape.mjs`).
//
// Prints:
//   - resolved entity name + namespace
//   - element (field) list with type
//   - one sample row if any exist
//
// Update the "Confirmed shape" comment below after each CAP major bump.
//
// Confirmed shape (CAP 10.x, 2026-07-06):
//   - Entity: cds.outbox.Messages
//   - Field: `target` (String) — event name, format `cron.<jobName>` for scheduled jobs
//   - Field: `status` (String) — 'processing' when row is picked up
//

import cds from '@sap/cds';
import path from 'node:path';

async function main() {
  await cds.deploy([
    path.join(process.cwd(), 'db'),
    path.join(process.cwd(), 'srv'),
    path.join(process.cwd(), 'node_modules/@sap/cds/srv/outbox.cds'),
  ]).to('sqlite::memory:');

  const outbox = cds.entities('cds.outbox');
  if (!outbox?.Messages) {
    console.error('FAIL: cds.entities("cds.outbox").Messages is missing');
    process.exit(2);
  }
  const M = outbox.Messages;
  console.log('Entity name:', M.name);
  console.log('Elements:');
  for (const [key, def] of Object.entries(M.elements)) {
    console.log(`  - ${key}: ${def.type}${def.key ? ' (key)' : ''}`);
  }
  const rows = await cds.run(SELECT.from(M));
  console.log(`Sample rows: ${rows.length}`);
  if (rows.length > 0) console.log(JSON.stringify(rows[0], null, 2));

  await cds.disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
