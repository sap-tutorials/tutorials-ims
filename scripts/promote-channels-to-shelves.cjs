'use strict';
const cds = require('@sap/cds');
const { promoteFeatured } = require('../srv/lib/channels/promote-to-shelves.js');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');
  const { upserted, skipped } = await promoteFeatured(db);
  console.log(`[promote-channels] upserted=${upserted} skipped=${skipped}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
