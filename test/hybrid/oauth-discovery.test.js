// test/hybrid/oauth-discovery.test.js
//
// Hybrid/deployed-dev: OAuth discovery documents.
// GETs both .well-known docs on the deployed dev env and asserts their shape.
//
// Uses SMOKE_BASE_URL if set; falls back to the known DEV approuter URL.
// Skipped if neither is reachable.
//
// (#1105 Task 17a)

import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL
  ?? process.env.HYBRID_APPROUTER_URL
  ?? 'https://tutorials-approuter-dev.cfapps.eu10-005.hana.ondemand.com';

// Probe reachability — skip if the target isn't available.
let targetReachable = false;
try {
  const probe = await fetch(`${BASE}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(5000),
  });
  targetReachable = probe.ok;
} catch {
  // not reachable
}

const describeIf = targetReachable ? describe : describe.skip;

describeIf('OAuth discovery documents (deployed dev)', { timeout: 20_000 }, () => {
  it('serves /.well-known/oauth-authorization-server with correct shape', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const doc = await res.json();
    // RFC 8414 required fields
    expect(typeof doc.issuer).toBe('string');
    // issuer is the approuter's own base URL (self-as-AS), which may be a
    // cfapps *.hana.ondemand.com host or the developers.sap.com vanity host.
    expect(doc.issuer).toMatch(/hana\.ondemand\.com|sap\.com|localhost/);
    expect(doc.authorization_endpoint).toBeDefined();
    // The authorize/token endpoints still live on XSUAA.
    expect(doc.authorization_endpoint).toMatch(/authentication\..*hana\.ondemand\.com/);
    expect(doc.token_endpoint).toBeDefined();
    // MCP 2.1 requires PKCE support
    const methods = doc.code_challenge_methods_supported ?? [];
    expect(methods).toContain('S256');
    // Public clients must be supported (no client_secret required)
    const authMethods = doc.token_endpoint_auth_methods_supported ?? ['none'];
    expect(authMethods).toContain('none');
  });

  it('serves /.well-known/oauth-protected-resource with Tutorial.MCP scope', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const doc = await res.json();
    // RFC 9728 shape
    expect(typeof doc.resource).toBe('string');
    // The resource URL should identify the MCP-auth endpoint
    expect(doc.resource).toBeTruthy();
    // scopes_supported must include Tutorial.MCP
    const scopes = doc.scopes_supported ?? [];
    expect(scopes).toContain('Tutorial.MCP');
    // authorization_servers advertises the approuter itself (self-as-AS), so
    // clients discover the RFC 8414 doc here rather than at XSUAA's non-8414 host.
    expect(Array.isArray(doc.authorization_servers)).toBe(true);
    expect(doc.authorization_servers.length).toBeGreaterThan(0);
  });

  it('serves /.well-known/openid-configuration identical to oauth-authorization-server', async () => {
    const [as, oidc] = await Promise.all([
      fetch(`${BASE}/.well-known/oauth-authorization-server`).then(r => r.json()),
      fetch(`${BASE}/.well-known/openid-configuration`).then(r => r.json()),
    ]);
    expect(oidc).toEqual(as);
  });

  it('serves /.well-known/mcp.json with the four servers', async () => {
    const res = await fetch(`${BASE}/.well-known/mcp.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const doc = await res.json();
    expect(doc.servers.map(s => s.name)).toEqual(['search', 'homepage', 'graph', 'developer']);
    expect(doc.authorization.protected_resource).toContain('/.well-known/oauth-protected-resource');
  });
});
