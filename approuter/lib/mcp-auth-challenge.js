// approuter/lib/mcp-auth-challenge.js
//
// Emits the MCP-spec-preferred discovery trigger: a 401 with a
// `WWW-Authenticate: Bearer resource_metadata="…"` pointer on the protected MCP
// namespaces, so compliant clients follow the pointer to the protected-resource
// metadata instead of blindly probing /.well-known. Runtime middleware; mirrors
// the srv-side /mcp-pat short-circuit in srv/server.js. Only fires when NO
// Authorization header is present, so a valid bearer always passes through.

const { resolveBaseUrl, resolveScope } = require('./well-known-oauth')

const MCP_AUTH_PREFIXES = ['/mcp-auth', '/mcp-admin']

function matchesProtectedMcp(pathOnly) {
  return MCP_AUTH_PREFIXES.some(p => pathOnly === p || pathOnly.startsWith(p + '/'))
}

function mcpAuthChallengeHandler(req, res, next) {
  const pathOnly = (req.url || '').split('?')[0]
  if (!matchesProtectedMcp(pathOnly)) return next()

  const authz = req.headers && req.headers.authorization
  if (authz && authz.startsWith('Bearer ')) return next()

  const baseUrl = resolveBaseUrl(req)
  const scope = resolveScope()
  if (baseUrl) {
    res.setHeader('WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${scope}"`)
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required.' }))
}

module.exports = { mcpAuthChallengeHandler, MCP_AUTH_PREFIXES }
