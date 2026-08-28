import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const XSUAA = { xsuaa: [{ credentials: {
  url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
  xsappname: 'tutorials!t676072',
} }] };
function mockRes() {
  return { statusCode: null, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); return this; },
    end(p) { this.body = p; return this; } };
}
let mod, prevVcap;
beforeAll(() => { prevVcap = process.env.VCAP_SERVICES; process.env.VCAP_SERVICES = JSON.stringify(XSUAA);
  mod = require('../../approuter/lib/mcp-auth-challenge.js'); });
afterAll(() => { if (prevVcap === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = prevVcap; });

describe('mcp-auth-challenge', () => {
  it('401s with a resource_metadata pointer when no bearer on /mcp-auth', () => {
    const { mcpAuthChallengeHandler } = mod;
    const res = mockRes(); let nexted = false;
    mcpAuthChallengeHandler(
      { method: 'POST', url: '/mcp-auth/api',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com' } },
      res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe(
      'Bearer resource_metadata="https://developers.sap.com/.well-known/oauth-protected-resource", scope="tutorials!t676072.Tutorial.MCP"');
  });

  it('passes through when an Authorization bearer is present', () => {
    const { mcpAuthChallengeHandler } = mod;
    const res = mockRes(); let nexted = false;
    mcpAuthChallengeHandler(
      { method: 'POST', url: '/mcp-auth/api', headers: { authorization: 'Bearer abc' } },
      res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('ignores unrelated paths', () => {
    const { mcpAuthChallengeHandler } = mod;
    const res = mockRes(); let nexted = false;
    mcpAuthChallengeHandler({ method: 'GET', url: '/tutorials/foo', headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(true);
  });
});
