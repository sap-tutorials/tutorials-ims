// approuter/lib/well-known-mcp-manifest.js
//
// Serves /.well-known/mcp.json — a NON-STANDARD convenience manifest listing the
// hosted MCP endpoints. NOT part of the MCP spec (server publishing is via the
// central MCP Registry's server.json); we serve it as a courtesy. Runtime
// middleware, mirroring well-known-oauth.js / security-txt.js. Base URL from the
// request; scope from the bound XSUAA binding (qualified form).

const { resolveBaseUrl, resolveScope } = require('./well-known-oauth')

const MCP_MANIFEST_PATH = '/.well-known/mcp.json'

function buildManifest(baseUrl, scope) {
  return {
    $comment: 'Non-standard convenience manifest; not part of the MCP specification.',
    name: 'SAP Developers MCP',
    provider: 'SAP Tutorials (developers.sap.com)',
    servers: [
      { name: 'search',    url: `${baseUrl}/mcp/search`,   auth: 'none' },
      { name: 'homepage',  url: `${baseUrl}/mcp/homepage`, auth: 'none' },
      { name: 'graph',     url: `${baseUrl}/mcp/graph`,    auth: 'none' },
      { name: 'developer', url: `${baseUrl}/mcp-auth/api`,  auth: 'oauth2', scope },
    ],
    authorization: { protected_resource: `${baseUrl}/.well-known/oauth-protected-resource` },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' })
  res.end(JSON.stringify(body, null, 2))
}

function mcpManifestHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const pathOnly = (req.url || '').split('?')[0]
  if (pathOnly !== MCP_MANIFEST_PATH) return next()

  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) return sendJson(res, 503, { error: 'mcp_manifest_unavailable' })
  return sendJson(res, 200, buildManifest(baseUrl, resolveScope()))
}

module.exports = { mcpManifestHandler, MCP_MANIFEST_PATH, buildManifest }
