const hdb = require('hdb');
const credsJson = process.env.IMS_HANA_CREDENTIALS;
if (!credsJson) {
  console.error('✗ IMS_HANA_CREDENTIALS env var not set');
  process.exit(1);
}
const creds = JSON.parse(credsJson);
console.log('Probing IMS PROD HANA...');
console.log('  host=' + creds.host);
console.log('  port=' + creds.port);
console.log('  user=' + creds.user);
console.log('  schema=' + creds.schema);
const client = hdb.createClient({
  host: creds.host,
  port: parseInt(creds.port),
  user: creds.user,
  password: creds.password,
  useTLS: true,
  encrypt: true,
  sslValidateCertificate: false,
});
const t0 = Date.now();
client.connect(err => {
  if (err) {
    console.error('✗ connect error after ' + (Date.now() - t0) + 'ms:', err.message);
    process.exit(1);
  }
  console.log('✓ Connected to IMS PROD HANA in ' + (Date.now() - t0) + 'ms');
  client.exec('SELECT COUNT(*) AS CT FROM IMSDBUSER.IMS_TASK_RECORD', (err2, rows) => {
    if (err2) { console.error('✗ query error:', err2.message); process.exit(1); }
    console.log('  TaskRecords in source: ' + rows[0].CT);
    process.exit(0);
  });
});
setTimeout(() => { console.error('✗ TIMEOUT'); process.exit(2); }, 30000);
