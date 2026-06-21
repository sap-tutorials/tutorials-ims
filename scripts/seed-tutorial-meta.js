#!/usr/bin/env node
// Seed TutorialMeta records for dashboard testing
// Usage: npx cds bind --exec -- node scripts/seed-tutorial-meta.js

import cds from '@sap/cds';

// #450: matches the runtime cron threshold (srv/lib/contributor-notifications.js
// STALE_DAYS_DEFAULT). Seeded dev data populates notificationNumber for rows
// older than this threshold; keeps dev/prod semantics aligned.
const STALE_THRESHOLD_DAYS = 90;

async function main() {
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');
  const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');

  // Check existing TutorialMeta count
  const existing = await SELECT.from(TutorialMeta).columns('ID').limit(1);
  if (existing.length > 0) {
    console.log('TutorialMeta records already exist. Skipping seed.');
    const count = await SELECT.one.from(TutorialMeta).columns('count(*) as cnt');
    console.log(`Current count: ${count.cnt}`);
    process.exit(0);
  }

  // Get tutorials to link
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'legacyId', 'title', 'primaryTag').limit(50);
  console.log(`Found ${tutorials.length} tutorials to create meta records for.`);

  if (tutorials.length === 0) {
    console.log('No tutorials found in database. Cannot seed TutorialMeta.');
    process.exit(1);
  }

  // Generate TutorialMeta records
  const owners = [
    'thomas.jung@sap.com', 'daniel.wroblewski@sap.com', 'nico.schoenteich@sap.com',
    'marius.obert@sap.com', 'kevin.muessig@sap.com', 'oliver.kohl@sap.com',
    'jan.penninkhof@sap.com', 'rich.heilman@sap.com'
  ];

  const statuses = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'WARNING', 'WARNING', 'CRITICAL', 'ARCHIVED'];

  // Get next legacyId
  const maxLegacy = await db.run(`SELECT MAX("LEGACYID") as "max" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"`);
  let nextLegacyId = (maxLegacy[0]?.max || 0) + 1;

  const now = new Date();
  const records = tutorials.map((t, i) => {
    const daysAgo = Math.floor(Math.random() * 365);
    const reviewedDate = new Date(now - daysAgo * 86400000).toISOString();
    const notifDaysAgo = Math.floor(Math.random() * 30);
    const lastNotificationDate = daysAgo > STALE_THRESHOLD_DAYS
      ? new Date(now - notifDaysAgo * 86400000).toISOString()
      : null;

    return {
      ID: cds.utils.uuid(),
      tutorial_ID: t.ID,
      reviewedDate,
      owner: owners[i % owners.length],
      monitoredStatus: statuses[i % statuses.length],
      notificationNumber: daysAgo > STALE_THRESHOLD_DAYS ? Math.floor(Math.random() * 4) + 1 : 0,
      lastNotificationDate,
      legacyId: nextLegacyId++
    };
  });

  console.log(`Inserting ${records.length} TutorialMeta records...`);
  await INSERT.into(TutorialMeta).entries(records);
  console.log('Done! TutorialMeta records seeded successfully.');

  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
