// test/unit/a2a/skills.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../srv/lib/chat-orchestrator.js', () => ({
  dispatchTool: vi.fn(async (name, args) => ({ echoed: name, args })),
  streamChat: vi.fn(async ({ res }) => { res.write('data: ' + JSON.stringify({ type: 'delta', content: 'hi' }) + '\n\n'); res.write('data: ' + JSON.stringify({ type: 'done' }) + '\n\n'); }),
}));
vi.mock('../../../srv/lib/chat-invocation.js', () => ({
  buildChatInvocation: vi.fn(async () => ({ system: 'S', tools: [], effectivePageContext: { kind: 'generic' } })),
}));
vi.mock('../../../srv/lib/a2a/task-store.js', () => ({ putTask: vi.fn(async () => {}) }));

import { resolveSkillId, runToolSkill, runChatSkillStream, A2aError, SKILL_TOOL_MAP } from '../../../srv/lib/a2a/skills.js';
import { streamChat } from '../../../srv/lib/chat-orchestrator.js';
import { putTask } from '../../../srv/lib/a2a/task-store.js';

describe('resolveSkillId', () => {
  it('reads params.metadata.skillId', () => {
    expect(resolveSkillId({}, { metadata: { skillId: 'search-tutorials' } })).toBe('search-tutorials');
  });
  it('defaults to tutorial-chat', () => {
    expect(resolveSkillId({}, {})).toBe('tutorial-chat');
  });
});

describe('runToolSkill', () => {
  it('maps search-tutorials to searchTutorials with query arg', async () => {
    const out = await runToolSkill({ skillId: 'search-tutorials', text: 'CAP', user: { id: 'u1' } });
    expect(out.echoed).toBe('searchTutorials');
    expect(out.args).toEqual({ query: 'CAP' });
  });
  it('maps user-progress to getUserProgress (no arg)', async () => {
    const out = await runToolSkill({ skillId: 'user-progress', text: '', user: { id: 'u1' } });
    expect(out.echoed).toBe('getUserProgress');
  });
  it('throws A2aError -32602 for unknown skill', async () => {
    await expect(runToolSkill({ skillId: 'nope', text: 'x', user: {} })).rejects.toMatchObject({ code: -32602 });
  });
  // FIX 8: prototype-pollution guard — __proto__ must not match a skill.
  it('throws A2aError -32602 for __proto__ skill lookup', async () => {
    await expect(runToolSkill({ skillId: '__proto__', text: 'x', user: {} })).rejects.toMatchObject({ code: -32602 });
  });
  it('throws A2aError -32602 for constructor skill lookup', async () => {
    await expect(runToolSkill({ skillId: 'constructor', text: 'x', user: {} })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('runChatSkillStream', () => {
  beforeEach(() => {
    putTask.mockClear();
    streamChat.mockClear();
  });

  it('drives streamChat over the SSE shim producing A2A events', async () => {
    const written = [];
    const res = { write: (s) => written.push(s), flush(){}, setHeader(){}, flushHeaders(){}, on(){}, end(){} };
    await runChatSkillStream({ message: { role: 'user', parts: [{ kind: 'text', text: 'q' }] }, user: { id: 'u1', attr: {} }, res, taskId: 't1', contextId: 'c1', settings: { deploymentId: 'd1' }, isAdmin: false });
    expect(written.join('')).toContain('status-update');
    expect(written.join('')).toContain('completed');
  });

  // FIX 4 (IDOR): putTask snapshots must include userId.
  it('includes userId in all putTask snapshots (working and completed)', async () => {
    const res = { write: () => {}, flush(){}, setHeader(){}, flushHeaders(){}, on(){}, end(){} };
    await runChatSkillStream({ message: { role: 'user', parts: [{ kind: 'text', text: 'q' }] }, user: { id: 'user-abc', attr: {} }, res, taskId: 't2', contextId: 'c2', settings: { deploymentId: 'd1' }, isAdmin: false });
    // Every putTask call must carry userId.
    for (const call of putTask.mock.calls) {
      const snapshot = call[1];
      expect(snapshot.userId).toBe('user-abc');
    }
  });

  // FIX 3: when streamChat emits a {type:'error'} frame the final putTask
  // state must be 'failed', not 'completed'.
  it('stores failed state when streamChat emits an error frame', async () => {
    streamChat.mockImplementationOnce(async ({ res: shimRes }) => {
      shimRes.write('data: ' + JSON.stringify({ type: 'error', reason: 'upstream failure' }) + '\n\n');
    });
    const res = { write: () => {}, flush(){}, setHeader(){}, flushHeaders(){}, on(){}, end(){} };
    await runChatSkillStream({ message: { role: 'user', parts: [{ kind: 'text', text: 'q' }] }, user: { id: 'u1', attr: {} }, res, taskId: 't3', contextId: 'c3', settings: { deploymentId: 'd1' }, isAdmin: false });
    // The last putTask call should record state:'failed'.
    const calls = putTask.mock.calls;
    const lastSnapshot = calls[calls.length - 1][1];
    expect(lastSnapshot.state).toBe('failed');
  });
});
