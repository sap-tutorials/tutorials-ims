const http = require('http');
// Make a direct request to CAP without following redirects
const opts = {
  hostname: 'localhost',
  port: 4004,
  path: '/admin/Tutorials',
  method: 'GET',
  headers: { 'Accept': 'application/json' }
};
const req = http.request(opts, (res) => {
  console.log("Status:", res.statusCode);
  console.log("Location:", res.headers.location || '(none)');
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log("Body:", body.substring(0, 200)));
});
req.end();
