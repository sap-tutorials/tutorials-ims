const cds = require('@sap/cds');
process.env.NODE_ENV = 'production'; // mimic deployed runtime
(async () => {
  // Load the full model BEFORE connect, so service definitions are present
  cds.model = await cds.load(['srv', 'db', 'app']);

  await cds.connect.to('db');

  // 1) Direct read via CDS QL on the source view
  const direct = await SELECT.from('ims.CompletionAnalytics');
  console.log('1) CDS QL direct read on ims.CompletionAnalytics:', direct.length, 'rows');
  if (direct.length > 0) console.log('   first:', JSON.stringify(direct[0]));

  // 2) Read via AdminService projection
  const admin = await cds.connect.to('AdminService');
  const projRows = await admin.run(SELECT.from('AdminService.CompletionAnalytics'));
  console.log('2) AdminService.CompletionAnalytics via SELECT.from:', projRows.length, 'rows');

  // 3) Read via .read() helper
  const readRows = await admin.read('CompletionAnalytics');
  console.log('3) AdminService.read("CompletionAnalytics"):', readRows.length, 'rows');

  // 4) Aggregate via $apply pattern using cds.ql groupby
  const agg = await cds.run(
    SELECT.from('AdminService.CompletionAnalytics')
      .columns('taskType', { ref: ['completionCount'], func: 'sum', as: 'total' })
      .groupBy('taskType')
  );
  console.log('4) Aggregate by taskType:', JSON.stringify(agg, null, 2));
})().catch(e => { console.error('ERR:', e.message || e); console.error(e.stack); process.exit(1); });
