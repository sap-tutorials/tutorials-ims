'use strict';
// Usage: cds bind --exec -- node scripts/seed-collections.cjs [--commit]
const cds = require('@sap/cds');
const { seedCollections } = require('../srv/lib/channels/seed-collections.js');

(async () => {
  const commit = process.argv.includes('--commit');
  await cds.load('*'); // ensure cds.model is populated for cds.linked in the lib
  const db = await cds.connect.to('db');
  const res = await seedCollections(db, { commit });
  console.log(`[seed-collections] commit=${commit}`, res);
  if (!commit) console.log('[seed-collections] dry run — pass --commit to write. Drafts land as AI_SEEDED; review in /admin-ui/#channelCollections.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
