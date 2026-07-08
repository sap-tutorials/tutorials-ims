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
});
