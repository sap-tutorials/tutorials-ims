const cds = require('@sap/cds');
(async () => {
  await cds.connect.to('db');

  const ims = await cds.run("SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME LIKE 'IMS_%' ORDER BY TABLE_NAME");
  console.log('IMS_ tables:', ims.map(r => r.TABLE_NAME).join(', '));

  const imsViews = await cds.run("SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND VIEW_NAME LIKE 'IMS_%' ORDER BY VIEW_NAME");
  console.log('IMS_ views:', imsViews.map(r => r.VIEW_NAME).join(', '));

  const all = await cds.run("SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND (VIEW_NAME LIKE '%COMPLETION%' OR VIEW_NAME LIKE '%ANALYTIC%')");
  console.log('Any view matching completion/analytic:', JSON.stringify(all, null, 2));
})().catch(e => { console.error('ERR:', e); process.exit(1); });
