import { describe, it, expect } from 'vitest';
import { toolsForContext } from '../../srv/lib/chat-orchestrator.js';

describe('toolsForContext', () => {
  it('learner pageContext: only searchTutorials', () => {
    const tools = toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials']);
  });
  it('admin pageContext + admin scope: includes admin docs and analytics', () => {
    const tools = toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: true });
    const names = tools.map(t => t.function.name);
    expect(names).toContain('searchAdminDocs');
    expect(names).toContain('analyticsQuery');
  });
  it('forged admin context from learner: admin tools NOT exposed', () => {
    const tools = toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('searchAdminDocs');
    expect(names).not.toContain('analyticsQuery');
  });
});
