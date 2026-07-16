import { describe, it, expect } from 'vitest';
import { buildAgentCard, SKILL_IDS } from '../../../srv/lib/a2a/agent-card.js';

describe('buildAgentCard', () => {
  const card = buildAgentCard({ baseUrl: 'https://host.example', tokenUrl: 'https://uaa.example/oauth/token', enabled: true });

  it('has required A2A top-level fields', () => {
    for (const k of ['protocolVersion','name','description','url','preferredTransport','version','capabilities','defaultInputModes','defaultOutputModes','skills','securitySchemes','security']) {
      expect(card[k], `missing ${k}`).toBeDefined();
    }
    expect(card.url).toBe('https://host.example/a2a');
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.capabilities.streaming).toBe(true);
  });

  it('advertises exactly the five skills', () => {
    expect(card.skills.map(s => s.id).sort()).toEqual([...SKILL_IDS].sort());
    for (const s of card.skills) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(Array.isArray(s.examples)).toBe(true);
    }
  });

  it('injects tokenUrl into the xsuaa security scheme', () => {
    expect(card.securitySchemes.xsuaa.flows.clientCredentials.tokenUrl).toBe('https://uaa.example/oauth/token');
    expect(card.security).toEqual([{ xsuaa: ['Tutorial.MCP'] }]);
  });

  it('signals unavailability when disabled but still returns a card', () => {
    const off = buildAgentCard({ baseUrl: 'https://host.example', tokenUrl: 't', enabled: false });
    expect(off.name).toBeTruthy();
    expect(off.metadata?.available).toBe(false);
  });
});
