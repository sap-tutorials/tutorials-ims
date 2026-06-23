const cds = require("@sap/cds");
(async () => {
  const db = await cds.connect.to("db");
  // Tables that the racers partially-filled. They have no children that aren't also being re-migrated, so safe to clear.
  // Note: we DO NOT truncate Users — it landed at full source count and is consistent.
  // We DO clear TaskRecords because it's only 42% loaded.
  // We do NOT clear AccomplishmentRecords / PrizeRecords yet — they were untouched (migrator hadn't reached them).
  const tables = [
    "COM_SAP_DEVELOPERS_IMS_TASKRECORDS",
  ];
  for (const t of tables) {
    const before = await db.run(`SELECT COUNT(*) AS C FROM ${t}`);
    process.stdout.write(`Clearing ${t} (${before[0].C} rows)... `);
    await db.run(`DELETE FROM ${t}`);
    const after = await db.run(`SELECT COUNT(*) AS C FROM ${t}`);
    console.log(`now ${after[0].C}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
