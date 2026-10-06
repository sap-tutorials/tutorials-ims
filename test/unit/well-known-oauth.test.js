import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// The approuter middleware is CommonJS; load it via require from ESM.
const require = createRequire(import.meta.url);
const {
  wellKnownOAuthHandler,
  resolveIssuer,
  resolveBaseUrl,
  resolveScope,
  authorizationServerMetadata,
  protectedResourceMetadata,
} = require('../../approuter/lib/well-known-oauth.js');

// Minimal mock of the (req, res, next) trio the approuter middleware uses.
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(payload) { this.body = payload; return this; },
  };
}

const SAVED_VCAP = process.env.VCAP_SERVICES;
const SAVED_TENANT = process.env.XSUAA_TENANT;
const SAVED_REGION = process.env.XSUAA_REGION;
const SAVED_ISSUER_KIND = process.env.MCP_ISSUER_KIND;

function setXsuaaBinding(url, xsappname) {
  const credentials = { url };
  if (xsappname) credentials.xsappname = xsappname;
  process.env.VCAP_SERVICES = JSON.stringify({ xsuaa: [{ credentials }] });
}

describe('.well-known OAuth discovery — dynamic runtime middleware (#1105)', () => {
  beforeEach(() => {
    delete process.env.VCAP_SERVICES;
    delete process.env.XSUAA_TENANT;
    delete process.env.XSUAA_REGION;
    delete process.env.XSUAA_MCP_URL;
    delete process.env.XSUAA_MCP_XSAPPNAME;
    delete process.env.MCP_ISSUER_KIND;
  });
  afterEach(() => {
    if (SAVED_VCAP === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = SAVED_VCAP;
    if (SAVED_TENANT === undefined) delete process.env.XSUAA_TENANT; else process.env.XSUAA_TENANT = SAVED_TENANT;
    if (SAVED_REGION === undefined) delete process.env.XSUAA_REGION; else process.env.XSUAA_REGION = SAVED_REGION;
    if (SAVED_ISSUER_KIND === undefined) delete process.env.MCP_ISSUER_KIND; else process.env.MCP_ISSUER_KIND = SAVED_ISSUER_KIND;
  });

  it('derives the issuer from the bound xsuaa VCAP credentials', () => {
    setXsuaaBinding('https://tutorial-system.authentication.eu10-005.hana.ondemand.com/');
    expect(resolveIssuer()).toBe('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
  });

  it('falls back to XSUAA_TENANT/XSUAA_REGION env when no binding present', () => {
    process.env.XSUAA_TENANT = 'developers-sap';
    process.env.XSUAA_REGION = 'eu10';
    expect(resolveIssuer()).toBe('https://developers-sap.authentication.eu10.hana.ondemand.com');
  });

  it('returns null issuer when neither binding nor env is available', () => {
    expect(resolveIssuer()).toBeNull();
  });

  it('derives base URL from x-forwarded headers, then host', () => {
    expect(resolveBaseUrl({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com' } }))
      .toBe('https://developers.sap.com');
    expect(resolveBaseUrl({ headers: { host: 'tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com' } }))
      .toBe('https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com');
  });

  it('resolves the fully-qualified scope from the bound xsappname', () => {
    // XSUAA only grants the MCP scope under its <xsappname>.<scope> name; the
    // bare short name is rejected with invalid_scope. mcp-remote copies
    // scopes_supported verbatim, so the discovery docs must advertise the
    // qualified form. Live-verified on Dev 2026-07-13 (#1105 criterion 8).
    setXsuaaBinding('https://t.authentication.eu10.hana.ondemand.com', 'tutorials!t676072');
    expect(resolveScope()).toBe('tutorials!t676072.Everyone');
  });

  it('falls back to the short scope name when no xsappname is bound', () => {
    delete process.env.VCAP_SERVICES;
    expect(resolveScope()).toBe('Everyone');
  });

  it('authorization-server metadata has all RFC 8414 required fields', () => {
    // issuer = self (approuter base); endpoints = XSUAA base.
    const m = authorizationServerMetadata('https://developers.sap.com', 'https://t.authentication.eu10.hana.ondemand.com', 'tutorials!t676072.Tutorial.MCP');
    for (const key of [
      'issuer', 'authorization_endpoint', 'token_endpoint',
      'response_types_supported', 'grant_types_supported',
      'code_challenge_methods_supported', 'scopes_supported',
      'token_endpoint_auth_methods_supported',
    ]) {
      expect(m).toHaveProperty(key);
    }
    expect(m.code_challenge_methods_supported).toContain('S256');
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
    // Advertised issuer is the approuter itself (self), NOT the XSUAA URL —
    // clients discover the AS doc here instead of at XSUAA's broken well-known.
    expect(m.issuer).toBe('https://developers.sap.com');
    // ...but the authorize/token endpoints still point at XSUAA.
    expect(m.authorization_endpoint).toBe('https://t.authentication.eu10.hana.ondemand.com/oauth/authorize');
    expect(m.token_endpoint).toBe('https://t.authentication.eu10.hana.ondemand.com/oauth/token');
    // Must advertise the fully-qualified, grantable scope — not the bare name.
    expect(m.scopes_supported).toContain('tutorials!t676072.Tutorial.MCP');
    expect(m.scopes_supported).not.toContain('Tutorial.MCP');
  });

  it('protected-resource metadata has MCP 2025-06 required fields', () => {
    const m = protectedResourceMetadata('https://host.example', 'tutorials!t676072.Tutorial.MCP');
    expect(m.resource).toBe('https://host.example/mcp-auth');
    // authorization_servers advertises the approuter (self), not XSUAA.
    expect(m.authorization_servers).toEqual(['https://host.example']);
    expect(m.scopes_supported).toContain('tutorials!t676072.Tutorial.MCP');
    expect(m.bearer_methods_supported).toEqual(['header']);
  });

  it('served authorization-server doc advertises the qualified scope from the binding', () => {
    setXsuaaBinding('https://tutorial-system.authentication.eu10-005.hana.ondemand.com', 'tutorials!t676072');
    const res = mockRes();
    wellKnownOAuthHandler(
      { method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'x.example' } },
      res,
      () => {},
    );
    const parsed = JSON.parse(res.body);
    expect(parsed.scopes_supported).toContain('tutorials!t676072.Everyone');
  });

  it('serves the authorization-server doc at its path with 200 + JSON', () => {
    setXsuaaBinding('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
    const res = mockRes();
    let nexted = false;
    wellKnownOAuthHandler(
      { method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'x.example' } },
      res,
      () => { nexted = true; },
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(res.body);
    // issuer is the SELF host (request-derived), not the XSUAA URL...
    expect(parsed.issuer).toBe('https://x.example');
    // ...while the endpoints still point at the bound XSUAA.
    expect(parsed.authorization_endpoint).toBe('https://tutorial-system.authentication.eu10-005.hana.ondemand.com/oauth/authorize');
  });

  it('serves the protected-resource doc keyed to the request host', () => {
    setXsuaaBinding('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
    const res = mockRes();
    wellKnownOAuthHandler(
      { method: 'GET', url: '/.well-known/oauth-protected-resource', headers: { host: 'real-host.cfapps.eu10-005.hana.ondemand.com' } },
      res,
      () => {},
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.resource).toBe('https://real-host.cfapps.eu10-005.hana.ondemand.com/mcp-auth');
  });

  // The core regression guard for the #1105 build-time-substitution bug:
  // the SERVED output must never contain an unsubstituted ${…} placeholder.
  it('served docs contain no unsubstituted ${…} placeholders', () => {
    setXsuaaBinding('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
    for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
      const res = mockRes();
      wellKnownOAuthHandler({ method: 'GET', url, headers: { host: 'h.example' } }, res, () => {});
      expect(res.statusCode).toBe(200);
      expect(res.body, `${url} leaked a placeholder`).not.toMatch(/\$\{[A-Za-z_]+\}/);
    }
  });

  it('returns 503 (not 404) when no issuer can be resolved', () => {
    const res = mockRes();
    wellKnownOAuthHandler(
      { method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'x.example' } },
      res,
      () => {},
    );
    expect(res.statusCode).toBe(503);
  });

  it('passes through non-matching paths to next()', () => {
    const res = mockRes();
    let nexted = false;
    wellKnownOAuthHandler(
      { method: 'GET', url: '/.well-known/ord/v1/documents/ord', headers: { host: 'x.example' } },
      res,
      () => { nexted = true; },
    );
    expect(nexted).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

describe('.well-known OAuth discovery — IAS issuer (MCP_ISSUER_KIND=ias)', () => {
  const SAVED_VCAP = process.env.VCAP_SERVICES;
  const SAVED_MCP_URL = process.env.XSUAA_MCP_URL;
  const SAVED_ISSUER_KIND = process.env.MCP_ISSUER_KIND;
  const IAS_ISSUER = 'https://atxgsg7zi.accounts.ondemand.com';

  beforeEach(() => {
    delete process.env.VCAP_SERVICES;
    process.env.MCP_ISSUER_KIND = 'ias';
    process.env.XSUAA_MCP_URL = IAS_ISSUER;
  });
  afterEach(() => {
    if (SAVED_VCAP === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = SAVED_VCAP;
    if (SAVED_MCP_URL === undefined) delete process.env.XSUAA_MCP_URL; else process.env.XSUAA_MCP_URL = SAVED_MCP_URL;
    if (SAVED_ISSUER_KIND === undefined) delete process.env.MCP_ISSUER_KIND; else process.env.MCP_ISSUER_KIND = SAVED_ISSUER_KIND;
  });

  it('advertises the plain OIDC `openid` scope, not the XSUAA qualified form', () => {
    // IAS is OIDC-compliant and its JWTs carry no scopes; the MCP tier gates on
    // authenticated-user. So discovery advertises bare `openid`.
    expect(resolveScope()).toBe('openid');
  });

  it('uses IAS /oauth2/* endpoint paths and openid-only scopes_supported', () => {
    const m = authorizationServerMetadata('https://developers.sap.com', IAS_ISSUER, 'openid');
    // RFC 9207: for IAS the advertised issuer MUST be the IAS base (what IAS
    // stamps as `iss`), NOT the self-URL passed as the first arg — otherwise
    // mcp-remote rejects the authorize response with IssuerMismatchError.
    expect(m.issuer).toBe(IAS_ISSUER);
    expect(m.authorization_endpoint).toBe(`${IAS_ISSUER}/oauth2/authorize`);
    expect(m.token_endpoint).toBe(`${IAS_ISSUER}/oauth2/token`);
    expect(m.scopes_supported).toEqual(['openid']);
    // Public client: no secret at the token endpoint.
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
    expect(m.code_challenge_methods_supported).toContain('S256');
  });

  it('served AS doc points authorize/token at IAS /oauth2/* and advertises the IAS issuer', () => {
    const res = mockRes();
    wellKnownOAuthHandler(
      { method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'x.example' } },
      res,
      () => {},
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    // IAS path: issuer is the IAS base (RFC 9207), not the approuter self-host.
    expect(parsed.issuer).toBe(IAS_ISSUER);
    expect(parsed.authorization_endpoint).toBe(`${IAS_ISSUER}/oauth2/authorize`);
    expect(parsed.scopes_supported).toEqual(['openid']);
  });

  it('protected-resource metadata points authorization_servers at IAS directly (RFC 8414 §3.3 + 9207)', () => {
    // IAS serves its own valid RFC 8414 doc, so the client must discover AGAINST
    // IAS — not the approuter self-host. Advertising the approuter would make the
    // client fetch our doc (issuer=IAS) from the approuter URL and fail RFC 8414
    // §3.3 (issuer != fetched-from). authorization_servers[0] must be the IAS base.
    const m = protectedResourceMetadata('https://x.example', 'openid');
    expect(m.authorization_servers).toEqual([IAS_ISSUER]);
    // The resource is still the approuter-hosted MCP endpoint.
    expect(m.resource).toBe(`https://x.example${'/mcp-auth'}`);
  });
});

describe('well-known-oauth: openid-configuration alias', () => {
  const SAVED_VCAP = process.env.VCAP_SERVICES;
  beforeEach(() => {
    process.env.VCAP_SERVICES = JSON.stringify({ xsuaa: [{ credentials: {
      url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
      xsappname: 'tutorials!t676072',
    } }] });
  });
  afterEach(() => {
    if (SAVED_VCAP === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = SAVED_VCAP;
  });

  it('serves openid-configuration with the same body as oauth-authorization-server', () => {
    const { OPENID_CONFIG_PATH } = require('../../approuter/lib/well-known-oauth.js');
    expect(OPENID_CONFIG_PATH).toBe('/.well-known/openid-configuration');
    const res = mockRes();
    let nexted = false;
    wellKnownOAuthHandler({ method: 'GET', url: OPENID_CONFIG_PATH, headers: { host: 'x.example' } }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    const doc = JSON.parse(res.body);
    expect(doc).toEqual(authorizationServerMetadata(
      'https://x.example', 'https://tenant.authentication.eu10-005.hana.ondemand.com', resolveScope()));
    expect(doc.code_challenge_methods_supported).toContain('S256');
  });
});

describe('well-known-oauth: consent-proxy flip (MCP_CONSENT_ENABLED)', () => {
  const SAVED = process.env.MCP_CONSENT_ENABLED;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.MCP_CONSENT_ENABLED; else process.env.MCP_CONSENT_ENABLED = SAVED;
  });

  it('points authorize/token at OUR /mcp-oauth endpoints and advertises self as issuer', () => {
    process.env.MCP_CONSENT_ENABLED = 'true';
    const SELF = 'https://developers.sap.com';
    const m = authorizationServerMetadata(SELF, 'https://tenant.accounts.ondemand.com', 'openid');
    expect(m.issuer).toBe(SELF);
    expect(m.authorization_endpoint).toBe(`${SELF}/mcp-oauth/authorize`);
    expect(m.token_endpoint).toBe(`${SELF}/mcp-oauth/token`);
    expect(m.scopes_supported).toEqual(['openid']);
    expect(m.code_challenge_methods_supported).toContain('S256');
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('does NOT flip when the flag is off (falls through to IdP endpoints)', () => {
    delete process.env.MCP_CONSENT_ENABLED;
    const m = authorizationServerMetadata('https://developers.sap.com',
      'https://t.authentication.eu10-005.hana.ondemand.com', 'tutorials-mcp.Everyone');
    expect(m.authorization_endpoint).not.toContain('/mcp-oauth/');
  });
});
