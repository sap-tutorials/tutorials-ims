const hdb = require('hdb');
const creds = JSON.parse(process.env.IMS_HANA_CREDENTIALS);
const client = hdb.createClient({
  host: creds.host, port: parseInt(creds.port),
  user: creds.user, password: creds.password,
  useTLS: true, encrypt: true, sslValidateCertificate: false,
});
const t0 = Date.now();
client.connect(err => {
  if (err) { console.error('connect:', err.message); process.exit(1); }
  console.log('✓ Connected in', Date.now() - t0, 'ms');

  // The exact query the migrator's lookup-map phase does — count first
  const t1 = Date.now();
  client.exec(`SELECT COUNT(*) AS CT FROM IMSDBUSER.IMS_USER`, (e1, rows) => {
    if (e1) { console.error('count failed:', e1.message); process.exit(1); }
    console.log('✓ IMS_USER count:', rows[0].CT, 'in', Date.now() - t1, 'ms');

    // Now the actual map-build query — full table scan
    const t2 = Date.now();
    let count = 0;
    let lastReport = Date.now();
    client.exec(`SELECT "ID", "UUID", "SAP_ID" FROM IMSDBUSER.IMS_USER`, (e2, rows) => {
      if (e2) {
        console.error('full scan failed at row', count, ':', e2.message);
        console.error('  code:', e2.code);
        process.exit(1);
      }
      console.log('✓ Full scan returned', rows.length, 'rows in', Date.now() - t2, 'ms');
      console.log('  First row sample:', JSON.stringify(rows[0]).slice(0, 200));
      process.exit(0);
    });
  });
});
setTimeout(() => { console.error('TIMEOUT after 90s'); process.exit(2); }, 90000);
