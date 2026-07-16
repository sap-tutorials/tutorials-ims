// test/unit/a2a/message-adapter.test.js
import { describe, it, expect } from 'vitest';
import { a2aMessageToInternal, extractText, mapFrame, makeSseShim, terminalTaskEvent } from '../../../srv/lib/a2a/message-adapter.js';

describe('a2aMessageToInternal', () => {
  it('flattens text parts into a single user message', () => {
    const msg = { role: 'user', parts: [{ kind: 'text', text: 'How do I ' }, { kind: 'text', text: 'use CAP?' }] };
    const out = a2aMessageToInternal(msg);
    expect(out.messages).toEqual([{ role: 'user', content: 'How do I use CAP?' }]);
    expect(out.pageContext).toEqual({ kind: 'generic' });
  });
  it('extractText tolerates missing parts', () => {
    expect(extractText({})).toBe('');
  });
});

describe('mapFrame', () => {
  const ctx = { taskId: 't1', contextId: 'c1' };
  it('maps a delta to a working status-update with a text part', () => {
    const ev = mapFrame({ type: 'delta', content: 'Hello' }, ctx);
    expect(ev.kind).toBe('status-update');
    expect(ev.status.state).toBe('working');
    expect(ev.taskId).toBe('t1');
    expect(JSON.stringify(ev)).toContain('Hello');
  });
  it('maps done to a completed final status-update', () => {
    const ev = mapFrame({ type: 'done' }, ctx);
    expect(ev.kind).toBe('status-update');
    expect(ev.status.state).toBe('completed');
    expect(ev.final).toBe(true);
  });
  it('maps error to a failed status-update', () => {
    const ev = mapFrame({ type: 'error', reason: 'boom' }, ctx);
    expect(ev.status.state).toBe('failed');
    expect(ev.final).toBe(true);
  });
  it('maps a card frame to an artifact-update', () => {
    const ev = mapFrame({ type: 'tutorial-cards', cards: [{ slug: 'x' }] }, ctx);
    expect(ev.kind).toBe('artifact-update');
    expect(ev.artifact.name).toBe('tutorial-cards');
  });
  it('swallows tool frames (returns null)', () => {
    expect(mapFrame({ type: 'tool', name: 'searchTutorials' }, ctx)).toBeNull();
  });
});

describe('makeSseShim', () => {
  it('rewrites orchestrator data frames into A2A SSE events on the real res', () => {
    const written = [];
    const realRes = { write: (s) => written.push(s), flush: () => {}, setHeader: () => {}, flushHeaders: () => {}, on: () => {}, end: () => {} };
    const shim = makeSseShim(realRes, { taskId: 't1', contextId: 'c1' });
    shim.write('data: ' + JSON.stringify({ type: 'delta', content: 'Hi' }) + '\n\n');
    shim.write('data: ' + JSON.stringify({ type: 'done' }) + '\n\n');
    const joined = written.join('');
    expect(joined).toContain('status-update');
    expect(joined).toContain('Hi');
    expect(joined).toContain('completed');
  });
});

// FIX 2: terminalTaskEvent includes artifacts when passed a non-empty array,
// and omits the field when empty or absent.
describe('terminalTaskEvent', () => {
  it('includes artifacts in the event when a non-empty array is provided', () => {
    const artifact = { name: 'tutorial-cards', parts: [{ kind: 'data', data: {} }] };
    const ev = terminalTaskEvent({ taskId: 't1', contextId: 'c1', state: 'completed', text: 'done', artifacts: [artifact] });
    expect(ev.kind).toBe('task');
    expect(Array.isArray(ev.artifacts)).toBe(true);
    expect(ev.artifacts.length).toBe(1);
    expect(ev.artifacts[0].name).toBe('tutorial-cards');
  });

  it('omits artifacts field when empty array is provided', () => {
    const ev = terminalTaskEvent({ taskId: 't1', contextId: 'c1', state: 'completed', text: 'done', artifacts: [] });
    expect(ev.artifacts).toBeUndefined();
  });

  it('omits artifacts field when artifacts param is absent', () => {
    const ev = terminalTaskEvent({ taskId: 't1', contextId: 'c1', state: 'completed', text: 'done' });
    expect(ev.artifacts).toBeUndefined();
  });

  it('includes text in status.message when text is provided', () => {
    const ev = terminalTaskEvent({ taskId: 't1', contextId: 'c1', state: 'completed', text: 'hello' });
    expect(ev.status.message.parts[0].text).toBe('hello');
  });

  it('omits status.message when text is empty/absent', () => {
    const ev = terminalTaskEvent({ taskId: 't1', contextId: 'c1', state: 'failed' });
    expect(ev.status.message).toBeUndefined();
  });
});
