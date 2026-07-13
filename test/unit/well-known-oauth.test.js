import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// The approuter middleware is CommonJS; load it via require from ESM.
const require = createRequire(import.meta.url);
const {
  wellKnownOAuthHandler,
  resolveIssuer,
  resolveBaseUrl,
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

function setXsuaaBinding(url) {
  process.env.VCAP_SERVICES = JSON.stringify({ xsuaa: [{ credentials: { url } }] });
}

describe('.well-known OAuth discovery — dynamic runtime middleware (#1105)', () => {
  beforeEach(() => {
    delete process.env.VCAP_SERVICES;
    delete process.env.XSUAA_TENANT;
    delete process.env.XSUAA_REGION;
  });
  afterEach(() => {
    if (SAVED_VCAP === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = SAVED_VCAP;
    if (SAVED_TENANT === undefined) delete process.env.XSUAA_TENANT; else process.env.XSUAA_TENANT = SAVED_TENANT;
    if (SAVED_REGION === undefined) delete process.env.XSUAA_REGION; else process.env.XSUAA_REGION = SAVED_REGION;
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

  it('authorization-server metadata has all RFC 8414 required fields', () => {
    const m = authorizationServerMetadata('https://t.authentication.eu10.hana.ondemand.com');
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
    expect(m.authorization_endpoint).toBe('https://t.authentication.eu10.hana.ondemand.com/oauth/authorize');
  });

  it('protected-resource metadata has MCP 2025-06 required fields', () => {
    const m = protectedResourceMetadata('https://host.example', 'https://t.authentication.eu10.hana.ondemand.com');
    expect(m.resource).toBe('https://host.example/mcp-auth');
    expect(m.authorization_servers).toEqual(['https://t.authentication.eu10.hana.ondemand.com']);
    expect(m.scopes_supported).toContain('Tutorial.MCP');
    expect(m.bearer_methods_supported).toEqual(['header']);
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
    expect(parsed.issuer).toBe('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
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
