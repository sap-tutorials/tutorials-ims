import cds from '@sap/cds';

const VIEW_SQL = `CREATE VIEW "COM_SAP_DEVELOPERS_IMS_SEARCHABLEITEMS" AS SELECT
  "ID",
  "LEGACYID",
  "TITLE",
  "DESCRIPTION",
  "SLUG",
  "PRIMARYTAG",
  "EXPERIENCETAG",
  "AVERAGETIMETOCOMPLETE",
  "STATUS",
  'TUTORIAL' AS "TASKTYPE"
FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
WHERE "STATUS" IS NULL OR "STATUS" = 'ACTIVE'
UNION ALL SELECT
  "ID",
  "LEGACYID",
  "TITLE",
  "DESCRIPTION",
  "SLUG",
  "PRIMARYTAG",
  "EXPERIENCETAG",
  "AVERAGETIMETOCOMPLETE",
  "STATUS",
  'MISSION' AS "TASKTYPE"
FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
WHERE "STATUS" IS NULL OR "STATUS" = 'ACTIVE'
UNION ALL SELECT
  "ID",
  "LEGACYID",
  "TITLE",
  "DESCRIPTION",
  NULL AS "SLUG",
  "PRIMARYTAG",
  "EXPERIENCETAG",
  "AVERAGETIMETOCOMPLETE",
  "STATUS",
  'GROUP' AS "TASKTYPE"
FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"
WHERE "STATUS" IS NULL OR "STATUS" = 'ACTIVE'`;

async function main() {
  await cds.connect.to('db');
  const db = cds.db;

  // Drop and recreate schema-level view
  try {
    await db.run('DROP VIEW "COM_SAP_DEVELOPERS_IMS_SEARCHABLEITEMS"');
    console.log('Dropped existing schema view');
  } catch (e) {
    console.log('Schema view did not exist yet');
  }
  await db.run(VIEW_SQL);
  console.log('Schema view created');

  // Verify data
  const count = await db.run('SELECT COUNT(*) AS "cnt" FROM "COM_SAP_DEVELOPERS_IMS_SEARCHABLEITEMS"');
  console.log(`View contains ${count[0]?.cnt ?? 0} rows`);

  // Sample to confirm columns work
  const sample = await db.run('SELECT TOP 3 "TITLE", "TASKTYPE", "STATUS" FROM "COM_SAP_DEVELOPERS_IMS_SEARCHABLEITEMS"');
  console.log('Sample rows:', JSON.stringify(sample));

  // Service-level view
  try {
    await db.run('DROP VIEW "SEARCHSERVICE_SEARCHABLEITEMS"');
  } catch (e) { /* ok */ }
  await db.run(`CREATE VIEW "SEARCHSERVICE_SEARCHABLEITEMS" AS SELECT * FROM "COM_SAP_DEVELOPERS_IMS_SEARCHABLEITEMS"`);
  console.log('Service view created');

  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
