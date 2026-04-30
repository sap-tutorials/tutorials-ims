import cds from '@sap/cds';

async function main() {
  await cds.connect.to('db');
  const db = cds.db;

  const tStatus = await db.run('SELECT DISTINCT "STATUS", COUNT(*) AS "cnt" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" GROUP BY "STATUS"');
  console.log('Tutorial statuses:', JSON.stringify(tStatus));

  const mStatus = await db.run('SELECT DISTINCT "STATUS", COUNT(*) AS "cnt" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" GROUP BY "STATUS"');
  console.log('Mission statuses:', JSON.stringify(mStatus));

  const gStatus = await db.run('SELECT DISTINCT "STATUS", COUNT(*) AS "cnt" FROM "COM_SAP_DEVELOPERS_IMS_GROUPS" GROUP BY "STATUS"');
  console.log('Group statuses:', JSON.stringify(gStatus));

  const total = await db.run('SELECT COUNT(*) AS "cnt" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"');
  console.log('Total tutorials:', total[0]?.cnt);

  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
