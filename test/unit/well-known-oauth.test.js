import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('.well-known OAuth discovery templates', () => {
  it('oauth-authorization-server.template has all RFC 8414 required fields', () => {
    const raw = fs.readFileSync('approuter/static/.well-known/oauth-authorization-server.template', 'utf8');
    const parsed = JSON.parse(raw);
    for (const key of [
      'issuer', 'authorization_endpoint', 'token_endpoint',
      'response_types_supported', 'grant_types_supported',
      'code_challenge_methods_supported', 'scopes_supported',
      'token_endpoint_auth_methods_supported'
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.code_challenge_methods_supported).toContain('S256');
    expect(parsed.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('oauth-protected-resource.template has MCP 2025-06 required fields', () => {
    const raw = fs.readFileSync('approuter/static/.well-known/oauth-protected-resource.template', 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('resource');
    expect(parsed).toHaveProperty('authorization_servers');
    expect(parsed).toHaveProperty('scopes_supported');
    expect(parsed.scopes_supported).toContain('Tutorial.MCP');
    expect(parsed.bearer_methods_supported).toEqual(['header']);
  });

  it('scripts/build-well-known.mjs substitutes tenant/region', () => {
    const tmp = path.join(process.cwd(), 'test/tmp-well-known');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execSync(
      `node scripts/build-well-known.mjs --out ${tmp} --tenant test-tenant --region eu10-005 --base-url https://test.example.com`,
      { stdio: 'inherit' }
    );
    const authServer = JSON.parse(fs.readFileSync(path.join(tmp, 'oauth-authorization-server'), 'utf8'));
    expect(authServer.issuer).toBe('https://test-tenant.authentication.eu10-005.hana.ondemand.com');
    expect(authServer.authorization_endpoint).toBe('https://test-tenant.authentication.eu10-005.hana.ondemand.com/oauth/authorize');
    const protRes = JSON.parse(fs.readFileSync(path.join(tmp, 'oauth-protected-resource'), 'utf8'));
    expect(protRes.resource).toBe('https://test.example.com/mcp-auth');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
