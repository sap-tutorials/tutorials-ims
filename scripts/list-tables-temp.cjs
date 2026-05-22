const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  const schema = (await db.run(`SELECT CURRENT_SCHEMA AS S FROM DUMMY`))[0].S;
  console.log('Current schema:', schema);
  const rows = await db.run(`SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = '${schema}' ORDER BY TABLE_NAME`);
  console.log('Tables in schema:', rows.length);
  rows.forEach(r => console.log('  ', r.TABLE_NAME));
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
