// test/chat-orchestrator-community-peers.test.js
import { describe, it, expect } from 'vitest';
import { buildToolRegistry, buildSystemPromptLines } from '../srv/lib/chat-orchestrator.js';

describe('findCommunityPeers registry gating (#1126)', () => {
  it('is absent when communityPeersEnabled is false', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: false } }).map((t) => t.function.name);
    expect(names).not.toContain('findCommunityPeers');
  });
  it('is present when communityPeersEnabled is true', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: true } }).map((t) => t.function.name);
    expect(names).toContain('findCommunityPeers');
  });
  it('adds a system-prompt line when enabled', () => {
    const lines = buildSystemPromptLines({ settings: { communityPeersEnabled: true } });
    expect(lines.join('\n')).toMatch(/findCommunityPeers/);
  });
  it('emits no prompt line when disabled', () => {
    const lines = buildSystemPromptLines({ settings: { communityPeersEnabled: false } });
    expect(lines.join('\n')).not.toMatch(/findCommunityPeers/);
  });
  it('registers describeCommunity when communityPeersEnabled is true (#1173)', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: true } }).map((t) => t.function.name);
    expect(names).toContain('describeCommunity');
  });
  it('omits describeCommunity when communityPeersEnabled is false (#1173)', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: false } }).map((t) => t.function.name);
    expect(names).not.toContain('describeCommunity');
  });
});
