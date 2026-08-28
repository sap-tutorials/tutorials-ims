import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const XSUAA = { xsuaa: [{ credentials: {
  url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
  xsappname: 'tutorials!t676072',
} }] };

function mockRes() {
  return {
    statusCode: null, headers: null, body: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    end(p) { this.body = p; return this; },
  };
}

let mod, prevVcap;
beforeAll(() => { prevVcap = process.env.VCAP_SERVICES; process.env.VCAP_SERVICES = JSON.stringify(XSUAA);
  mod = require('../../approuter/lib/well-known-oauth.js'); });
afterAll(() => { if (prevVcap === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = prevVcap; });

describe('well-known-oauth: openid-configuration alias', () => {
  it('serves openid-configuration with the same body as oauth-authorization-server', () => {
    const { wellKnownOAuthHandler, OPENID_CONFIG_PATH, authorizationServerMetadata, resolveScope } = mod;
    expect(OPENID_CONFIG_PATH).toBe('/.well-known/openid-configuration');
    const res = mockRes();
    let nexted = false;
    wellKnownOAuthHandler({ method: 'GET', url: OPENID_CONFIG_PATH, headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc).toEqual(authorizationServerMetadata(
      'https://tenant.authentication.eu10-005.hana.ondemand.com', resolveScope()));
    expect(doc.code_challenge_methods_supported).toContain('S256');
  });
});
