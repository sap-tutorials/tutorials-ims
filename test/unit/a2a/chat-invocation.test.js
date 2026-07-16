import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../srv/lib/chat-orchestrator.js', () => ({
  toolsForContext: vi.fn(async () => [{ type: 'function', function: { name: 'searchTutorials' } }]),
}));
vi.mock('../../../srv/lib/chat-context.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'SYSTEM PROMPT'),
}));

import { buildChatInvocation } from '../../../srv/lib/chat-invocation.js';

describe('buildChatInvocation', () => {
  it('assembles system prompt + tools for a generic page', async () => {
    const user = { id: 'u1', attr: { given_name: 'Ada', family_name: 'Lovelace' } };
    const out = await buildChatInvocation({ pageContext: { kind: 'generic' }, user, settings: {}, isAdmin: false });
    expect(out.system).toBe('SYSTEM PROMPT');
    expect(out.tools).toHaveLength(1);
    expect(out.effectivePageContext.kind).toBe('generic');
  });

  it('degrades a forged admin pageContext to generic for non-admins', async () => {
    const user = { id: 'u1', attr: {} };
    const out = await buildChatInvocation({ pageContext: { kind: 'admin' }, user, settings: {}, isAdmin: false });
    expect(out.effectivePageContext.kind).toBe('generic');
  });
});
