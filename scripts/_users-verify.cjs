const cds = require("@sap/cds");
(async () => {
  const db = await cds.connect.to("db");
  // Are there any duplicate-ID Users? (Constraint enforces no, but worth checking via row count vs distinct)
  const r1 = await db.run(`SELECT COUNT(*) AS C, COUNT(DISTINCT "ID") AS D FROM COM_SAP_DEVELOPERS_IMS_USERS`);
  console.log("Users: total=" + r1[0].C + " distinct_ID=" + r1[0].D);
  const r2 = await db.run(`SELECT COUNT(*) AS C FROM COM_SAP_DEVELOPERS_IMS_USERS WHERE "SAPID" IS NULL`);
  console.log("Users with NULL sapId: " + r2[0].C);
  // Are there any uuid collisions from the racers?
  const r3 = await db.run(`SELECT "ID", COUNT(*) AS C FROM COM_SAP_DEVELOPERS_IMS_USERS GROUP BY "ID" HAVING COUNT(*) > 1 LIMIT 5`);
  console.log("Duplicate User IDs (should be 0): " + r3.length);
  // CHK: TaskRecords
  const r4 = await db.run(`SELECT COUNT(*) AS C, COUNT(DISTINCT "ID") AS D FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS`);
  console.log("TaskRecords: total=" + r4[0].C + " distinct_ID=" + r4[0].D);
  // TaskRecords highest LEGACYID processed
  const r5 = await db.run(`SELECT MAX("LEGACYID") AS M FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS`);
  console.log("Max TaskRecord LEGACYID seen: " + r5[0].M);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
