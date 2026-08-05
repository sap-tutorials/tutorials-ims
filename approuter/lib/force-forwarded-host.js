// approuter/lib/force-forwarded-host.js
//
// TEMPORARY DNS-cutover test aid. Overrides the inbound `X-Forwarded-Host`
// header with a fixed value so the approuter builds OAuth `redirect_uri`s (and
// any other host-derived URLs) against a known external hostname, regardless of
// what the fronting CDN (Akamai) forwards.
//
// WHY THIS EXISTS
//   During the developers.sap.com DNS cutover we front the prod approuter with
//   a temporary vanity host `developers-qa.sap.com` at the Akamai layer. Akamai
//   is not (yet) forwarding the real external host to the origin — the approuter
//   sees its own `*.cfapps.*.hana.ondemand.com` host in `X-Forwarded-Host`, so
//   the login callback redirects there and fails. `@sap/approuter` builds the
//   callback from `getRedirectHost()` = `x-forwarded-host || host` (see
//   node_modules/@sap/approuter/lib/utils/url-utils.js), with no config knob to
//   force a value — hence this middleware.
//
//   Setting `FORCE_FORWARDED_HOST=developers-qa.sap.com` makes every login
//   round-trip resolve to `https://developers-qa.sap.com/login/callback`, which
//   is allowlisted in xs-security-prod.json (PR #1495). This lets us validate
//   the full OAuth flow on the QA host BEFORE touching the legacy DNS.
//
// LIFECYCLE
//   - Now (QA test):    FORCE_FORWARDED_HOST=developers-qa.sap.com
//   - At DNS cutover:   flip to FORCE_FORWARDED_HOST=developers.sap.com (belt-
//                       and-suspenders vs. Akamai drift) OR unset entirely once
//                       Akamai forwards the correct host natively.
//   - Unset / empty  => middleware is a no-op (default). Safe to leave deployed.
//
// SAFETY / BLAST RADIUS
//   - Off by default: no env var => passthrough, byte-for-byte no behavior change.
//   - Does NOT affect CF gorouter instance routing (that keys off `Host`, decided
//     before app code runs) or the Autoscaler (CPU/mem metrics, never headers).
//     This is pure app-layer URL construction, downstream of both.
//   - It IS a blunt instrument: when set, ALL requests get the forced host,
//     including direct-to-cfapps access (smoke tests, debugging), whose OAuth
//     redirects would then also point at the forced host. Acceptable for a
//     temporary single-external-hostname deployment; remove at cutover.

function getForcedHost() {
  const v = (process.env.FORCE_FORWARDED_HOST || '').trim()
  return v || null
}

// Express-style middleware. Mount as the VERY FIRST entry of the approuter's
// insertMiddleware.first chain so the header is rewritten before both the
// well-known OAuth handler and @sap/approuter's built-in login middleware read
// it. Rewrites `x-forwarded-host` (the header getRedirectHost/getAppRouterHost
// consult first) and normalizes `x-forwarded-proto` to https, since the forced
// external host is always TLS-terminated at the CDN edge.
function forceForwardedHostHandler(req, res, next) {
  const forced = getForcedHost()
  if (forced) {
    req.headers['x-forwarded-host'] = forced
    // The external hostname is HTTPS at the edge; make the derived scheme match
    // so redirect_uri is https:// regardless of the origin hop's protocol.
    req.headers['x-forwarded-proto'] = 'https'
  }
  next()
}

module.exports = {
  forceForwardedHostHandler,
  // exported for unit tests
  getForcedHost,
}
