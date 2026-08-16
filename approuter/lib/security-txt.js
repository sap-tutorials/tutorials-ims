// approuter/lib/security-txt.js
//
// Serves the SAP canonical security.txt at /.well-known/security.txt (RFC 9116)
// DIRECTLY from the approuter, as middleware — NOT as a static file.
//
// Why middleware, not a static file:
//   Serving from the approuter middleware chain (insertMiddleware.first) makes
//   this deterministic — it ships with the approuter module and always answers
//   first, independent of whatever is in approuter/static/. (Historically it also
//   sidestepped the /admin/rebuild content push that atomically replaced static/;
//   that push was retired in #1659 C.4, but middleware remains the cleaner choice.)
//   Mirrors approuter/lib/well-known-oauth.js.
//
// Source of truth for the content:
//   github.tools.sap/sgsc-engineering-and-automation/securitytxt (SAP SGSC
//   PSRT team). SAP publishes the identical bytes at
//   https://www.sap.com/.well-known/security.txt, which is the public mirror
//   the drift-check workflow diffs against (the origin repo is SAP-internal and
//   unreachable from GitHub.com hosted runners). When SGSC bumps the content
//   (typically the Expires date), .github/workflows/security-txt-drift.yml
//   detects the change and opens a PR to update SECURITY_TXT below.
//
// Spec: RFC 9116 (A File Format to Aid in Security Vulnerability Disclosure).

const SECURITY_TXT_PATH = '/.well-known/security.txt'

// Canonical SAP security.txt. Keep byte-identical to
// https://www.sap.com/.well-known/security.txt (LF line endings, trailing
// newline, no other fields). scripts/check-security-txt-drift.cjs guards this.
const SECURITY_TXT =
  'Contact: https://www.sap.com/report-a-vulnerability\n' +
  'Expires: 2028-01-31T18:29:00.000Z\n'

// Express-style middleware. Mount at path '/' in the approuter's
// insertMiddleware.first chain, BEFORE the static/proxy handlers so this exact
// path is answered here and never falls through to the srv-api /.well-known/*
// proxy route in xs-app.json (which does not serve security.txt).
function securityTxtHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()

  // Strip any query string before matching.
  const pathOnly = (req.url || '').split('?')[0]
  if (pathOnly !== SECURITY_TXT_PATH) return next()

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  })
  // HEAD must not carry a body; GET serves the file.
  res.end(req.method === 'HEAD' ? undefined : SECURITY_TXT)
}

module.exports = {
  securityTxtHandler,
  // exported for the unit test and the drift-check script (single source of truth)
  SECURITY_TXT,
  SECURITY_TXT_PATH,
}
