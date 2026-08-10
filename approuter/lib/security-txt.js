// approuter/lib/security-txt.js
//
// Serves the SAP canonical security.txt at /.well-known/security.txt (RFC 9116)
// DIRECTLY from the approuter, as middleware — NOT as a static file.
//
// Why middleware, not a static file:
//   approuter/static/ is atomically REPLACED on every content publish
//   (rebuildHandler in approuter/server.js untars a fresh Hugo tree over it).
//   A file dropped in hugo/static/.well-known/ would only survive the swap by
//   coincidence and would depend on a content rebuild ever landing. Middleware
//   in the approuter's insertMiddleware.first chain always answers first and
//   ships with the approuter module itself, so it can never be wiped by a
//   content publish. Mirrors approuter/lib/well-known-oauth.js.
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
