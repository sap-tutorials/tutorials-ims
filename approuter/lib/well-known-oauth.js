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

// The MCP authenticated mount the resource metadata advertises.
const MCP_RESOURCE_SUFFIX = '/mcp-auth'

// The MCP scope, in its short (application-local) form. XSUAA only grants it
// at the /oauth/authorize endpoint under its FULLY-QUALIFIED name —
// `<xsappname>.<scope>` (e.g. `tutorials!t676072.Tutorial.MCP`). A request for
// the bare `Tutorial.MCP` is rejected with `invalid_scope` ("Tutorial.MCP is
// invalid. Please use a valid scope name in the request"). mcp-remote copies
// `scopes_supported` from these discovery docs verbatim into its authorize
// request, so the docs MUST advertise the qualified form. See resolveScope().
const MCP_SCOPE_SHORT = 'Tutorial.MCP'

// Prefix the short MCP scope with the bound xsappname to produce the
// fully-qualified, grantable scope name. Falls back to the short name only if
// the binding is unavailable (same degraded path as resolveIssuer()).
function resolveScope() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
    const xsappname = vcap.xsuaa && vcap.xsuaa[0] && vcap.xsuaa[0].credentials && vcap.xsuaa[0].credentials.xsappname
    if (xsappname) return `${xsappname}.${MCP_SCOPE_SHORT}`
  } catch { /* fall through */ }
  return MCP_SCOPE_SHORT
}

// Derive the XSUAA OAuth issuer base (e.g.
// https://tutorial-system.authentication.eu10-005.hana.ondemand.com) from the
// bound xsuaa VCAP credentials. Falls back to the XSUAA_TENANT/XSUAA_REGION
// env vars (set as mtaext env:) if the binding is somehow unavailable.
function resolveIssuer() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
    const xsuaa = vcap.xsuaa && vcap.xsuaa[0] && vcap.xsuaa[0].credentials
    if (xsuaa && xsuaa.url) return xsuaa.url.replace(/\/+$/, '')
  } catch { /* fall through to env */ }

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

function authorizationServerMetadata(issuer, scope) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', scope],
    token_endpoint_auth_methods_supported: ['none'],
  }
}

function protectedResourceMetadata(baseUrl, issuer, scope) {
  return {
    resource: `${baseUrl}${MCP_RESOURCE_SUFFIX}`,
    authorization_servers: [issuer],
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
  if (pathOnly !== AUTH_SERVER_PATH && pathOnly !== PROTECTED_RESOURCE_PATH) {
    return next()
  }

  const issuer = resolveIssuer()
  if (!issuer) {
    // No XSUAA binding and no env fallback — cannot produce a valid document.
    // 503 (not 404) so a misconfiguration is distinguishable from a missing route.
    return sendJson(res, 503, { error: 'oauth_metadata_unavailable' })
  }

  const scope = resolveScope()

  if (pathOnly === AUTH_SERVER_PATH) {
    return sendJson(res, 200, authorizationServerMetadata(issuer, scope))
  }

  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) return sendJson(res, 503, { error: 'oauth_metadata_unavailable' })
  return sendJson(res, 200, protectedResourceMetadata(baseUrl, issuer, scope))
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
}
