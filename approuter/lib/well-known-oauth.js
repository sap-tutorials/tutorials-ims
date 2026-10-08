// approuter/lib/well-known-oauth.js
//
// Serves the two OAuth 2.1 discovery documents (#1105) DYNAMICALLY at runtime
// instead of baking them at MTA build time.
//
// Why dynamic, not build-time substitution:
//   The original design (scripts/build-well-known.mjs, invoked from mta.yaml's
//   approuter build step) tried to substitute ${XSUAA_TENANT}/${XSUAA_REGION}/
//   ${APPROUTER_BASE_URL} into template files during `mbt build`. That never
//   worked: those values are mtaext `env:` entries (deploy-time CF app env),
//   NOT build-time shell vars, so mbt passed the literal strings through and
//   the baked files shipped with unsubstituted `${…}` placeholders. QA was
//   doubly broken — qa.mtaext defines none of the three vars at all.
//
//   Serving at runtime sidesteps all of it: the XSUAA issuer comes straight
//   from the bound VCAP xsuaa credentials (authoritative, present in every
//   env), and the protected-resource URL is derived from the inbound request
//   host — so it's correct regardless of any vanity-hostname config drift
//   (dev's APPROUTER_BASE_URL pointed at a host that doesn't even resolve).
//
// Spec refs: RFC 8414 (Authorization Server Metadata),
// RFC 9728 (Protected Resource Metadata), MCP 2025-06-18 auth.

const AUTH_SERVER_PATH = '/.well-known/oauth-authorization-server'
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
const OPENID_CONFIG_PATH = '/.well-known/openid-configuration'

// The MCP authenticated mount the resource metadata advertises.
const MCP_RESOURCE_SUFFIX = '/mcp-auth'

// The MCP scope, in its short (application-local) form. XSUAA only grants it
// at the /oauth/authorize endpoint under its FULLY-QUALIFIED name —
// `<xsappname>.<scope>` (e.g. `tutorials!t676072.Tutorial.MCP`). A request for
// the bare `Tutorial.MCP` is rejected with `invalid_scope` ("Tutorial.MCP is
// invalid. Please use a valid scope name in the request"). mcp-remote copies
// `scopes_supported` from these discovery docs verbatim into its authorize
// request, so the docs MUST advertise the qualified form. See resolveScope().
// Baseline MCP scope. The public MCP auth tier gates on `authenticated-user`
// (a valid logged-in token is enough — see xs-security-mcp.json + the design
// non-goal), so discovery advertises the baseline `Everyone` scope that
// tutorials-xsuaa-mcp defines, NOT the optional/elevated `Tutorial.MCP`.
// mcp-remote copies scopes_supported verbatim into its authorize request, and
// the requested scope must exist on the target (public) client.
const MCP_SCOPE_SHORT = 'Everyone'

// Issuer kind selects the OAuth shape. XSUAA and IAS differ in three ways the
// discovery doc must reflect:
//   - endpoint paths: XSUAA /oauth/authorize|/oauth/token; IAS /oauth2/*
//   - scope: XSUAA grants a fully-qualified <xsappname>.<scope>; IAS is OIDC and
//     its JWTs carry NO scopes — discovery advertises plain `openid`.
//   - client: IAS mints a public (secretless) client the platform XSUAA cannot.
// Read from MCP_ISSUER_KIND env (mtaext) at CALL TIME (not module load) so it
// tracks runtime config and is unit-testable. Defaults to 'xsuaa' when unset.
function isIasIssuer() {
  return (process.env.MCP_ISSUER_KIND || 'xsuaa').toLowerCase() === 'ias'
}

// When the self-hosted consent proxy (mcp-consent.js) is enabled, discovery must
// advertise OUR /mcp-oauth/authorize + /mcp-oauth/token as the authorize/token
// endpoints — that is where mcp-remote renders the "Application Access Request"
// consent screen before we broker the real IAS leg behind it. Read at call time
// so it tracks runtime config. See docs/superpowers/specs/2026-10-06-mcp-consent-
// screen-design.md.
function isConsentProxyEnabled() {
  return String(process.env.MCP_CONSENT_ENABLED || '').toLowerCase() === 'true'
}

// OAuth discovery for the MCP tier must advertise the PUBLIC tutorials-mcp
// instance (issuer + baseline scope). To avoid binding a SECOND xsuaa to the
// approuter (which would make @sap/approuter's own confidential LOGIN handshake
// ambiguous — the framework has no route-level selector and picks a binding
// non-deterministically), the public issuer/xsappname are supplied as PLAIN
// NON-SECRET config env (set in the mtaext): XSUAA_MCP_URL + XSUAA_MCP_XSAPPNAME.
// The approuter keeps its single confidential tutorials-xsuaa binding for login.
// Fallbacks (for flexibility): a bound tutorials-mcp xsuaa if one is present,
// then vcap.xsuaa[0] (local/degraded).
const MCP_XSAPPNAME = process.env.XSUAA_MCP_XSAPPNAME || 'tutorials-mcp'
function resolveMcpXsuaaCredentials() {
  // 1. Explicit non-secret env config — the intended production path (no 2nd binding).
  if (process.env.XSUAA_MCP_URL) {
    return { url: process.env.XSUAA_MCP_URL, xsappname: MCP_XSAPPNAME }
  }
  // 2. A bound tutorials-mcp xsuaa, selected by xsappname (not index).
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
    const bindings = Array.isArray(vcap.xsuaa) ? vcap.xsuaa : []
    const mcp = bindings.find(b => b && b.credentials && b.credentials.xsappname === MCP_XSAPPNAME)
    if (mcp) return mcp.credentials
    return bindings[0] && bindings[0].credentials
  } catch { return undefined }
}

// Prefix the short MCP scope with the bound MCP xsappname to produce the
// fully-qualified, grantable scope name. Falls back to the short name only if
// the binding is unavailable (same degraded path as resolveIssuer()).
function resolveScope() {
  // IAS is OIDC-compliant and its JWTs carry no scopes; the MCP tier gates on
  // `authenticated-user` (any valid token). Advertise plain `openid`.
  if (isIasIssuer()) return 'openid'
  const creds = resolveMcpXsuaaCredentials()
  const xsappname = creds && creds.xsappname
  if (xsappname) return `${xsappname}.${MCP_SCOPE_SHORT}`
  return MCP_SCOPE_SHORT
}

// Derive the XSUAA OAuth issuer base (e.g.
// https://tutorial-system.authentication.eu10-005.hana.ondemand.com) from the
// bound PUBLIC (tutorials-mcp) xsuaa credentials. Falls back to the
// XSUAA_TENANT/XSUAA_REGION env vars (set as mtaext env:) if unavailable.
function resolveIssuer() {
  const creds = resolveMcpXsuaaCredentials()
  if (creds && creds.url) return creds.url.replace(/\/+$/, '')

  const tenant = process.env.XSUAA_TENANT
  const region = process.env.XSUAA_REGION
  if (tenant && region) {
    return `https://${tenant}.authentication.${region}.hana.ondemand.com`
  }
  return null
}

// Derive the externally-visible base URL of THIS approuter from the request.
// Honors x-forwarded-proto/host (CF's Go router sets these) so the advertised
// resource matches the host the client actually reached us on.
function resolveBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) return null
  return `${proto}://${host}`
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  })
  res.end(payload)
}

// Build the RFC 8414 Authorization-Server metadata.
//
// `issuer` identifies the advertised authorization server. For XSUAA this is
// THIS approuter (its own externally-visible base URL) — NOT the raw XSUAA URL;
// the authorize / token endpoints still live on XSUAA (`endpointBase`). For IAS
// the issuer is the IAS base itself (see the RFC 9207 note in the function body).
//
// Why self-issuer for XSUAA (reverses the original Option A):
//   MCP clients (mcp-remote / MCP SDK) read the protected-resource metadata,
//   take `authorization_servers[0]`, and run RFC 8414 discovery against THAT
//   host. XSUAA does not implement RFC 8414 — `<xsuaa>/.well-known/oauth-
//   authorization-server` 302-redirects to /login, which returns 200 (an HTML
//   page). The SDK follows the redirect, sees 200, parses HTML as JSON, and
//   every required field is undefined → ZodError. Because the bogus response is
//   200 (not 404) the SDK never falls back to XSUAA's working openid-
//   configuration. Advertising the approuter itself (which serves a valid 200
//   RFC 8414 doc here) keeps XSUAA's broken well-known out of the discovery
//   path entirely; the actual authorize/token calls still hit XSUAA.
function authorizationServerMetadata(issuer, endpointBase, scope) {
  // Consent-proxy flip (highest precedence): when MCP_CONSENT_ENABLED, we ARE the
  // authorization server the client talks to — advertise OUR /mcp-oauth endpoints
  // and OUR self-URL (`issuer`, == baseUrl) as the issuer. mcp-consent.js brokers
  // the real IAS leg behind these. RFC 9207 holds because the client's authorize-
  // response iss is stamped by us (self), matching this advertised issuer.
  if (isConsentProxyEnabled()) {
    return {
      issuer,
      authorization_endpoint: `${issuer}/mcp-oauth/authorize`,
      token_endpoint: `${issuer}/mcp-oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid'],
      token_endpoint_auth_methods_supported: ['none'],
    }
  }
  // Endpoint paths differ by issuer: IAS serves /oauth2/authorize|/oauth2/token,
  // XSUAA serves /oauth/authorize|/oauth/token.
  const ias = isIasIssuer()
  const authzPath = ias ? '/oauth2/authorize' : '/oauth/authorize'
  const tokenPath = ias ? '/oauth2/token' : '/oauth/token'
  // IAS: plain `openid` (JWTs carry no scopes). XSUAA: `openid` + the qualified scope.
  const scopes = ias ? ['openid'] : ['openid', scope]
  // RFC 9207: the `issuer` MUST equal the `iss` the authorization server stamps on
  // its authorize/token responses; modern MCP clients (mcp-remote / MCP SDK) reject
  // an authorization response whose `iss` differs from the discovery `issuer`
  // (IssuerMismatchError). IAS stamps its OWN base (https://<tenant>.accounts.
  // ondemand.com) as `iss`, so for the IAS path the advertised issuer MUST be the
  // IAS base (endpointBase) — NOT the approuter self-URL. The self-issuer trick
  // below applies ONLY to XSUAA, which does not serve a valid RFC 8414 doc at its
  // own host (see the block comment above); IAS does serve one, so self-issuer is
  // both unnecessary and RFC-9207-breaking for IAS.
  const advertisedIssuer = ias ? endpointBase : issuer
  return {
    issuer: advertisedIssuer,
    authorization_endpoint: `${endpointBase}${authzPath}`,
    token_endpoint: `${endpointBase}${tokenPath}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: scopes,
    token_endpoint_auth_methods_supported: ['none'],
  }
}

// RFC 9728 Protected-Resource metadata. `authorization_servers` is the AS the
// MCP client runs discovery against.
//
// XSUAA path: advertise the approuter itself (baseUrl) — XSUAA serves no valid
// RFC 8414 doc at its own host, so we self-serve one (see authorizationServer
// Metadata()'s block comment) and proxy the endpoints to XSUAA.
//
// IAS path: advertise the IAS base DIRECTLY. IAS serves a standards-compliant
// RFC 8414 doc at its own host whose `issuer` equals that host — so a modern MCP
// client (mcp-remote / MCP SDK) satisfies BOTH RFC 8414 §3.3 (metadata `issuer`
// must equal the URL it was fetched from) AND RFC 9207 (authorize-response `iss`
// must equal the metadata `issuer`). The approuter self-issuer scheme cannot
// satisfy both at once for a proxied IAS — it makes fetched-from(approuter) ≠
// issuer(IAS) (8414 fails) or issuer(approuter) ≠ authorize-iss(IAS) (9207
// fails). Pointing discovery straight at IAS makes both hosts consistent.
//
// Consent-proxy flip (highest precedence): when MCP_CONSENT_ENABLED, the consent
// proxy (mcp-consent.js) IS a real RFC 8414 authorization server at the approuter
// self-URL (baseUrl) with a correct RFC 9207 `iss`, so we advertise OURSELVES as
// the authorization_server here too. This is load-bearing: the MCP client reads
// protected-resource metadata FIRST and runs discovery against authorization_
// servers[0]. If this still named IAS (as the plain IAS path does), the client
// would discover IAS directly and never reach our flipped authorization-server
// doc — the consent screen would be bypassed entirely. Must match the flip in
// authorizationServerMetadata().
function protectedResourceMetadata(baseUrl, scope) {
  const authServer = isConsentProxyEnabled() ? baseUrl : (isIasIssuer() ? resolveIssuer() : baseUrl)
  return {
    resource: `${baseUrl}${MCP_RESOURCE_SUFFIX}`,
    authorization_servers: [authServer],
    scopes_supported: [scope],
    bearer_methods_supported: ['header'],
  }
}

// Express-style middleware. Mount at path '/' in the approuter's
// insertMiddleware.first chain, BEFORE the static/proxy handlers so these two
// exact paths are answered here and never fall through to the srv-api
// /.well-known/* proxy (which does not serve them).
function wellKnownOAuthHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()

  // Strip any query string before matching.
  const pathOnly = (req.url || '').split('?')[0]
  if (pathOnly !== AUTH_SERVER_PATH && pathOnly !== PROTECTED_RESOURCE_PATH && pathOnly !== OPENID_CONFIG_PATH) {
    return next()
  }

  // XSUAA base — used ONLY for the authorize/token endpoint URLs, never as the
  // advertised issuer (see authorizationServerMetadata()).
  const endpointBase = resolveIssuer()
  if (!endpointBase) {
    // No XSUAA binding and no env fallback — cannot produce a valid document.
    // 503 (not 404) so a misconfiguration is distinguishable from a missing route.
    return sendJson(res, 503, { error: 'oauth_metadata_unavailable' })
  }

  const scope = resolveScope()

  // Both documents advertise THIS approuter (self) as the authorization server,
  // so both need the externally-visible base URL derived from the request.
  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) return sendJson(res, 503, { error: 'oauth_metadata_unavailable' })

  if (pathOnly === AUTH_SERVER_PATH || pathOnly === OPENID_CONFIG_PATH) {
    return sendJson(res, 200, authorizationServerMetadata(baseUrl, endpointBase, scope))
  }

  return sendJson(res, 200, protectedResourceMetadata(baseUrl, scope))
}

module.exports = {
  wellKnownOAuthHandler,
  // exported for unit tests
  resolveIssuer,
  resolveBaseUrl,
  resolveScope,
  authorizationServerMetadata,
  protectedResourceMetadata,
  AUTH_SERVER_PATH,
  PROTECTED_RESOURCE_PATH,
  OPENID_CONFIG_PATH,
}
