// test/unit/a2a/message-adapter.test.js
import { describe, it, expect, vi } from 'vitest';
import { a2aMessageToInternal, extractText, mapFrame, makeSseShim } from '../../../srv/lib/a2a/message-adapter.js';

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
