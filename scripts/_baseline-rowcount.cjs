const cds = require("@sap/cds");
const path = require("path");
const fs = require("fs");

const queries = [
  ["Tutorials", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS"],
  ["Missions", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_MISSIONS"],
  ["Groups", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_GROUPS"],
  ["CompletionPaths", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"],
  ["Steps", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_STEPS"],
  ["Users", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_USERS"],
  ["TaskRecords", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS"],
  ["Tags", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_TAGS"],
  ["Events", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_EVENTS"],
  ["AccomplishmentRecords", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS"],
  ["PrizeRecords", "SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_PRIZERECORDS"],
];
const corruption = [
  ["Step dups remaining",
   `SELECT COUNT(*) AS CT FROM (
      SELECT T."ID" FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS T
       WHERE T."STEPCOUNT" > 0
         AND (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_STEPS S
               WHERE S."TUTORIAL_ID" = T."ID") > T."STEPCOUNT"
    )`],
  ["NULL stepCount tutorials",
   `SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE "STEPCOUNT" IS NULL`],
  ["NULL slug CompletionPaths",
   `SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS WHERE "SLUG" IS NULL`],
  ["NULL sapId Users",
   `SELECT COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_USERS WHERE "SAPID" IS NULL`],
];

(async () => {
  const db = await cds.connect.to("db");
  const out = { capturedAt: new Date().toISOString(), env: "dev", rowCounts: {}, corruption: {} };
  for (const [name, sql] of queries) {
    try {
      const rows = await db.run(sql);
      out.rowCounts[name] = Number(rows[0]?.CT ?? rows[0]?.ct ?? 0);
    } catch (e) {
      out.rowCounts[name] = { error: e.message };
    }
  }
  for (const [metric, sql] of corruption) {
    try {
      const rows = await db.run(sql);
      out.corruption[metric] = Number(rows[0]?.CT ?? rows[0]?.ct ?? 0);
    } catch (e) {
      out.corruption[metric] = { error: e.message };
    }
  }
  const dir = path.join(process.cwd(), ".migration-data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "baseline-2026-06-23-pre-migration.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("Wrote", file);
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
