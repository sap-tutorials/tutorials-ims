import { describe, it, expect } from 'vitest';
import { buildMcpManifest } from '../../mcp/mcp-manifest.js';

const BASE = 'https://developers.sap.com';

describe('buildMcpManifest', () => {
  const m = buildMcpManifest({ baseUrl: BASE });

  it('advertises the anonymous SearchService tier at /mcp/search with auth none', () => {
    const anon = m.servers.find(s => s.url === `${BASE}/mcp/search`);
    expect(anon).toBeTruthy();
    expect(anon.authentication.type).toBe('none');
  });

  it('lists the three anonymous tools by name', () => {
    const anon = m.servers.find(s => s.url === `${BASE}/mcp/search`);
    const names = anon.tools.map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_tutorial_step', 'search_events', 'search_channels'])
    );
    // Every listed tool carries a human/agent-readable description.
    for (const t of anon.tools) expect(typeof t.description).toBe('string');
  });

  it('points to the authenticated tier via OAuth protected-resource metadata', () => {
    const authed = m.servers.find(s => s.url === `${BASE}/mcp-auth/api`);
    expect(authed).toBeTruthy();
    expect(authed.authentication.type).toBe('oauth2');
    expect(authed.authentication.protectedResourceMetadata)
      .toBe(`${BASE}/.well-known/oauth-protected-resource`);
  });

  it('does NOT advertise anonymous invocation of the authenticated tier', () => {
    // The authed server must not be marked auth:none, and its tools (if any are
    // listed) must never be reachable without OAuth — metadata only.
    const authed = m.servers.find(s => s.url === `${BASE}/mcp-auth/api`);
    expect(authed.authentication.type).not.toBe('none');
  });

  it('has a name and description at the top level', () => {
    expect(typeof m.name).toBe('string');
    expect(typeof m.description).toBe('string');
  });
});
