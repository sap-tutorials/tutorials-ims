'use strict';

/**
 * Build the anonymous MCP discovery manifest served at `/.well-known/mcp.json`.
 *
 * Purpose (#agent-readiness): give agents a zero-auth way to discover that this
 * site speaks MCP, which anonymous tools exist, and where the authenticated tier
 * lives. This is METADATA ONLY — it advertises the already-anonymous SearchService
 * tier (`/mcp/search`, tools annotated `@requires:'any'`) and points to the
 * authenticated DeveloperService tier (`/mcp-auth/api`) via its OAuth
 * protected-resource metadata. It does NOT expose authenticated tool invocation
 * anonymously; the authed server entry carries no tool list and no `none` auth.
 *
 * Kept in sync by hand with:
 *   - srv/search-service-mcp.cds  (the three `@requires:'any'` functions)
 *   - srv/search-service.cds      (`@protocol … {kind:'mcp', path:'/mcp/search'}`)
 *   - approuter/xs-app.json        (`/mcp/*` authenticationType:none, `/mcp-auth/*` xsuaa)
 *   - approuter/lib/well-known-oauth.js (`/.well-known/oauth-protected-resource`)
 *
 * @param {{baseUrl: string}} opts
 * @returns {object} manifest
 */
function buildMcpManifest({ baseUrl } = {}) {
  const base = String(baseUrl || 'https://developers.sap.com').replace(/\/$/, '');
  return {
    name: 'SAP Developers MCP',
    description:
      'Model Context Protocol access to developers.sap.com. The "search" server is ' +
      'anonymous and public; the "api" server exposes authenticated tools behind OAuth.',
    documentation: 'https://modelcontextprotocol.io',
    servers: [
      {
        name: 'search',
        description:
          'Anonymous, public MCP tools over SAP tutorials, community events, and ' +
          'external channels. No authentication required.',
        url: `${base}/mcp/search`,
        transport: 'http',
        authentication: { type: 'none' },
        tools: [
          {
            name: 'get_tutorial_step',
            description:
              "Return a single published tutorial step's HTML plus metadata " +
              '(step title, text length, total steps). Public content.',
          },
          {
            name: 'search_events',
            description:
              'Search the public SAP community events catalog (CodeJams, Devtoberfest, ' +
              'TechEd, user groups), filterable by type/region and ordered by start date.',
          },
          {
            name: 'search_channels',
            description:
              'Search the public external-channels catalog (SAP and community YouTube ' +
              'channels, blogs, podcasts, feeds), filterable by category/platform/owner.',
          },
        ],
      },
      {
        name: 'api',
        description:
          'Authenticated MCP tools (tutorial progress, personalized recommendations, ' +
          'and more). Requires an OAuth access token — see the protected-resource metadata.',
        url: `${base}/mcp-auth/api`,
        transport: 'http',
        authentication: {
          type: 'oauth2',
          protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource`,
        },
      },
    ],
  };
}

export { buildMcpManifest };
