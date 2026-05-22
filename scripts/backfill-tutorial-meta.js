#!/usr/bin/env node
// One-shot backfill: create default TutorialMeta rows for any Tutorial without one.
// Usage: npx cds bind --exec -- node scripts/backfill-tutorial-meta.js [--dry-run]

import cds from '@sap/cds';
import { backfillMissingTutorialMeta } from '../srv/lib/tutorial-meta-init.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');

  if (dryRun) {
    const orphans = await db.run(`
      SELECT t."ID", t.slug, t.title FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t
      LEFT JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" m ON m.tutorial_ID = t."ID"
      WHERE m."ID" IS NULL
    `);
    console.log(`Found ${orphans.length} Tutorials without TutorialMeta.`);
    orphans.slice(0, 20).forEach(t => console.log(`  - ${t.slug} (${t.title})`));
    process.exit(0);
  }

  const { created } = await backfillMissingTutorialMeta();
  console.log(`Created ${created} TutorialMeta rows.`);
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
