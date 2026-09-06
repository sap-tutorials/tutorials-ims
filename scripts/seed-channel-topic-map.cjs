'use strict';
// Usage: cds bind --exec -- node scripts/seed-channel-topic-map.cjs [--commit]
const cds = require('@sap/cds');
const { seedChannelTopicMap } = require('../srv/lib/channels/seed-channel-topic-map.cjs');

(async () => {
  const commit = process.argv.includes('--commit');
  await cds.load('*'); // ensure cds.model is populated for cds.linked in the lib
  const db = await cds.connect.to('db');
  const res = await seedChannelTopicMap(db, { commit });
  console.log(`[seed-channel-topic-map] commit=${commit}`, res);
  if (!commit) console.log('[seed-channel-topic-map] dry run — pass --commit to write. Drafts land as AI_SEEDED; review in /admin-ui/#channelTopicMap.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
