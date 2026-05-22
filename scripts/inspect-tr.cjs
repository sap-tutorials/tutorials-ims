const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  const rows = await db.run(`SELECT TOP 20 ID, USER_ID, TASKTYPE, STATUS, COMPLETIONDATE, MODIFIEDAT FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" ORDER BY MODIFIEDAT DESC NULLS LAST`);
  console.log('TaskRecords (most recent):');
  console.log(JSON.stringify(rows, null, 2));
  const [{ MIND, MAXD }] = await db.run(`SELECT MIN(MODIFIEDAT) AS MIND, MAX(MODIFIEDAT) AS MAXD FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS"`);
  console.log('Range:', MIND, '→', MAXD);
  const [{ U }] = await db.run(`SELECT COUNT(*) AS U FROM "COM_SAP_DEVELOPERS_IMS_USERS"`);
  console.log('Users:', U);
  // Check if SAP_CHANGELOG has anything
  try {
    const cl = await db.run(`SELECT TOP 10 ENTITY, "ACTION", CREATEDAT FROM "SAP_CHANGELOG_CHANGELOG" WHERE ENTITY LIKE '%TaskRecord%' OR ENTITY LIKE '%User%' ORDER BY CREATEDAT DESC`);
    console.log('Recent changelog (Users/TaskRecords):', JSON.stringify(cl, null, 2));
  } catch (e) { console.log('changelog err:', e.message); }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
