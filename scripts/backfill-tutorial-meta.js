#!/usr/bin/env node
// One-shot backfill: create default TutorialMeta rows for any Tutorial without one.
// Usage: npx cds bind --exec -- node scripts/backfill-tutorial-meta.js [--dry-run]

import cds from '@sap/cds';
import { getNextLegacyId } from '../srv/lib/legacy-id.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');
  const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');

  const orphans = await db.run(`
    SELECT t."ID", t.slug, t.title FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t
    LEFT JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" m ON m.tutorial_ID = t."ID"
    WHERE m."ID" IS NULL
  `);

  console.log(`Found ${orphans.length} Tutorials without TutorialMeta.`);
  if (dryRun) {
    orphans.slice(0, 20).forEach(t => console.log(`  - ${t.slug} (${t.title})`));
    process.exit(0);
  }

  let created = 0;
  for (const t of orphans) {
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: t.ID,
      owner: null,
      reviewedDate: null,           // Will be populated by next rebuild via Task 3
      monitoredStatus: 'ACTIVE',
      notificationNumber: 0,
      lastNotificationDate: null,
      legacyId: await getNextLegacyId('TutorialMeta', db)
    });
    created++;
  }

  console.log(`Created ${created} TutorialMeta rows.`);
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
