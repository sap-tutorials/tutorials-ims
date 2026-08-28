import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const XSUAA = { xsuaa: [{ credentials: {
  url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
  xsappname: 'tutorials!t676072',
} }] };
function mockRes() {
  return { statusCode: null, headers: null, body: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    end(p) { this.body = p; return this; } };
}
const REQ = { method: 'GET', url: '/.well-known/mcp.json',
  headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com' } };

let mod, prevVcap;
beforeAll(() => { prevVcap = process.env.VCAP_SERVICES; process.env.VCAP_SERVICES = JSON.stringify(XSUAA);
  mod = require('../../approuter/lib/well-known-mcp-manifest.js'); });
afterAll(() => { if (prevVcap === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = prevVcap; });

describe('well-known-mcp-manifest', () => {
  it('serves mcp.json with server list and qualified scope', () => {
    const { mcpManifestHandler } = mod;
    const res = mockRes();
    let nexted = false;
    mcpManifestHandler(REQ, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/application\/json/);
    const doc = JSON.parse(res.body);
    expect(doc.servers.map(s => s.name)).toEqual(['search', 'homepage', 'graph', 'developer']);
    const dev = doc.servers.find(s => s.name === 'developer');
    expect(dev.url).toBe('https://developers.sap.com/mcp-auth/api');
    expect(dev.scope).toBe('tutorials!t676072.Tutorial.MCP');
    expect(doc.authorization.protected_resource)
      .toBe('https://developers.sap.com/.well-known/oauth-protected-resource');
  });

  it('passes through non-matching paths and non-GET methods', () => {
    const { mcpManifestHandler } = mod;
    for (const req of [
      { method: 'GET', url: '/.well-known/other', headers: {} },
      { method: 'POST', url: '/.well-known/mcp.json', headers: {} },
    ]) {
      const res = mockRes(); let nexted = false;
      mcpManifestHandler(req, res, () => { nexted = true; });
      expect(nexted).toBe(true);
      expect(res.statusCode).toBeNull();
    }
  });
});
