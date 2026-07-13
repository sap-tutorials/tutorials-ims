// test/unit/approuter-mcp-route.test.js
//
// Guards the anonymous /mcp/* route in the approuter. The route must:
//   1. Exist (send MCP traffic to srv-api).
//   2. Be anonymous (`authenticationType: none`) — Phase 1 MCP has no auth.
//   3. Not overlap `/mcp-auth/*` — that namespace is RESERVED for Phase 2.
//
// (#912 Task 13)

import { expect, describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const XS_APP_PATH = path.join(process.cwd(), 'approuter', 'xs-app.json');
const xsapp = JSON.parse(fs.readFileSync(XS_APP_PATH, 'utf8'));

function findMcpRoute() {
  return xsapp.routes.find((r) => typeof r.source === 'string' && /^\^\/mcp\//.test(r.source));
}

describe('approuter /mcp/* route (#912)', () => {
  it('registers a route matching /mcp/…', () => {
    const route = findMcpRoute();
    expect(route, 'no /mcp/* route in approuter/xs-app.json').toBeDefined();
    expect(route.destination).toBe('srv-api');
  });

  it('is anonymous (authenticationType: none)', () => {
    const route = findMcpRoute();
    expect(route.authenticationType).toBe('none');
  });

  it('does not match the reserved /mcp-auth/* namespace', () => {
    const route = findMcpRoute();
    // Simplest guard — source string must not mention 'mcp-auth', and its
    // regex must fail against a sample /mcp-auth path.
    expect(route.source).not.toMatch(/mcp-auth/);
    const rx = new RegExp(route.source);
    expect(rx.test('/mcp-auth/something'), '/mcp/* route must not swallow /mcp-auth/*').toBe(false);
    expect(rx.test('/mcp/search'), '/mcp/* route must accept /mcp/search').toBe(true);
  });

  it('is ordered before the catch-all ^(.*)$ route', () => {
    const mcpIdx = xsapp.routes.findIndex((r) => typeof r.source === 'string' && /^\^\/mcp\//.test(r.source));
    const catchAllIdx = xsapp.routes.findIndex((r) => r.source === '^(.*)$');
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(-1);
    expect(mcpIdx, 'the /mcp/* route must be listed before the catch-all').toBeLessThan(catchAllIdx);
  });

  // The OAuth discovery docs (#1105) are NOT served via xs-app.json static
  // routes anymore — they are generated dynamically at runtime by the
  // wellKnownOAuthHandler middleware in server.js (registered first in
  // insertMiddleware.first, so it intercepts before xs-app routing). This
  // replaced the build-time-substitution approach, which shipped
  // unsubstituted ${…} placeholders. See approuter/lib/well-known-oauth.js
  // and test/unit/well-known-oauth.test.js. Assert the dead static routes are
  // GONE so nobody re-adds a shadowed/stale copy.
  it('does NOT declare static xs-app routes for the OAuth discovery docs', () => {
    const authServer = xsapp.routes.find((r) => r.source === '^/.well-known/oauth-authorization-server$');
    const protRes = xsapp.routes.find((r) => r.source === '^/.well-known/oauth-protected-resource$');
    expect(authServer, 'oauth-authorization-server is served dynamically, not via a static xs-app route').toBeUndefined();
    expect(protRes, 'oauth-protected-resource is served dynamically, not via a static xs-app route').toBeUndefined();
  });

  it('mounts /mcp-pat/* anonymous with csrfProtection false', () => {
    const route = xsapp.routes.find((r) => r.source === '^/mcp-pat/(.*)$');
    expect(route).toBeDefined();
    expect(route.authenticationType).toBe('none');
    expect(route.csrfProtection).toBe(false);
  });

  it('mounts /mcp-auth/* xsuaa with Tutorial.MCP scope gate', () => {
    const route = xsapp.routes.find((r) => r.source === '^/mcp-auth/(.*)$');
    expect(route).toBeDefined();
    expect(route.authenticationType).toBe('xsuaa');
    expect(route.csrfProtection).toBe(false);
    expect(route.scope).toBe('$XSAPPNAME.Tutorial.MCP');
  });

  it('orders /mcp-auth/* AFTER /mcp-pat/* AFTER /mcp/*', () => {
    const idxAnon = xsapp.routes.findIndex((r) => r.source === '^/mcp/(.*)$');
    const idxPat = xsapp.routes.findIndex((r) => r.source === '^/mcp-pat/(.*)$');
    const idxAuth = xsapp.routes.findIndex((r) => r.source === '^/mcp-auth/(.*)$');
    expect(idxAnon).toBeGreaterThanOrEqual(0);
    expect(idxPat).toBeGreaterThan(idxAnon);
    expect(idxAuth).toBeGreaterThan(idxPat);
  });
});
