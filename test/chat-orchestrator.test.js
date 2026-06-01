import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamMock = vi.fn();
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: class {
    stream(...args) { return streamMock(...args); }
  }
}));

const connectMock = vi.fn();
vi.mock('@sap/cds', () => {
  const fakeQuery = {
    from() { return this; },
    where() { return this; },
    columns() { return this; },
    search() { return this; },
    limit() { return this; }
  };
  globalThis.SELECT = { from: () => fakeQuery };
  return {
    default: {
      log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
      connect: { to: connectMock }
    }
  };
});

const { streamChat, dispatchTool } = await import('../srv/lib/chat-orchestrator.js');

function fakeRes() {
  const chunks = [];
  return {
    chunks,
    write(s) { chunks.push(String(s)); },
    end() { this.ended = true; }
  };
}

function makeStream(events) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function makeResponse(chunks, toolCalls = null) {
  return {
    stream: makeStream(chunks),
    getToolCalls: () => toolCalls
  };
}

describe('chat-orchestrator', () => {
  beforeEach(() => {
    streamMock.mockReset();
    connectMock.mockReset();
  });

  it('emits delta SSE events and a done event for plain text', async () => {
    streamMock.mockReturnValueOnce(makeResponse([
      { getDeltaContent: () => 'Hel' },
      { getDeltaContent: () => 'lo' }
    ]));
    const res = fakeRes();
    await streamChat({
      res, system: 'sys', messages: [{ role: 'user', content: 'hi' }], deploymentId: 'd1'
    });
    const joined = res.chunks.join('');
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"Hel"/);
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"lo"/);
    expect(joined).toMatch(/"type":"done"/);
    expect(res.ended).toBe(true);
  });

  it('runs the searchTutorials tool and re-invokes the model with results', async () => {
    const searchRun = vi.fn().mockResolvedValue([{ slug: 'a', title: 'A', type: 'tutorial' }]);
    connectMock.mockResolvedValue({ run: searchRun, entities: {} });

    streamMock.mockReturnValueOnce(makeResponse(
      [{ getDeltaContent: () => null }],
      [{ id: 't1', function: { name: 'searchTutorials', arguments: '{"query":"cap"}' } }]
    ));
    streamMock.mockReturnValueOnce(makeResponse([
      { getDeltaContent: () => 'Found it' }
    ]));

    const res = fakeRes();
    await streamChat({
      res, system: 's', messages: [{ role: 'user', content: 'find cap' }], deploymentId: 'd1'
    });

    expect(searchRun).toHaveBeenCalled();
    expect(streamMock).toHaveBeenCalledTimes(2);
    const joined = res.chunks.join('');
    expect(joined).toMatch(/"type":"tool"[^}]*"name":"searchTutorials"/);
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"Found it"/);
    expect(joined).toMatch(/"type":"done"/);
  });

  it('dispatchTool returns shaped hits from SearchService', async () => {
    const searchRun = vi.fn().mockResolvedValue([
      { slug: 'a', title: 'A', description: 'd', type: 'tutorial', primaryTag: 'cap' }
    ]);
    connectMock.mockResolvedValue({ run: searchRun, entities: {} });
    const result = await dispatchTool('searchTutorials', { query: 'cap', tags: ['cap'] });
    expect(searchRun).toHaveBeenCalled();
    expect(result).toEqual([
      { slug: 'a', title: 'A', description: 'd', type: 'tutorial', primaryTag: 'cap' }
    ]);
  });

  it('dispatchTool returns search_failed shape on error', async () => {
    connectMock.mockRejectedValue(new Error('boom'));
    const result = await dispatchTool('searchTutorials', { query: 'x' });
    expect(result).toEqual({ error: 'search_failed', hits: [] });
  });

  it('emits an error SSE event when the SDK throws', async () => {
    streamMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const res = fakeRes();
    await streamChat({ res, system: 's', messages: [], deploymentId: 'd1' });
    expect(res.chunks.join('')).toMatch(/"type":"error"/);
    expect(res.ended).toBe(true);
  });

  it('caps the agent loop to prevent infinite tool recursion', async () => {
    connectMock.mockResolvedValue({ run: vi.fn().mockResolvedValue([]), entities: {} });
    streamMock.mockImplementation(() => makeResponse(
      [{ getDeltaContent: () => null }],
      [{ id: 'x', function: { name: 'searchTutorials', arguments: '{"query":"q"}' } }]
    ));
    const res = fakeRes();
    await streamChat({ res, system: 's', messages: [{ role: 'user', content: 'q' }], deploymentId: 'd1' });
    expect(streamMock.mock.calls.length).toBe(5);
    expect(res.ended).toBe(true);
  });

  it('dispatchTool rejects non-string or empty queries before connecting', async () => {
    const result = await dispatchTool('searchTutorials', { query: { foo: 1 } });
    expect(result).toEqual({ error: 'invalid_args', hits: [] });

    const emptyResult = await dispatchTool('searchTutorials', { query: '' });
    expect(emptyResult).toEqual({ error: 'invalid_args', hits: [] });

    const whitespaceResult = await dispatchTool('searchTutorials', { query: '   ' });
    expect(whitespaceResult).toEqual({ error: 'invalid_args', hits: [] });

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('aborts mid-stream when the signal fires and skips the done event', async () => {
    const ac = new AbortController();
    streamMock.mockReturnValueOnce(makeResponse([
      { getDeltaContent: () => 'first' },
      // Abort between chunks; the loop checks signal at the top of each iteration.
      { getDeltaContent: () => { ac.abort(); return 'second-should-not-be-emitted'; } },
      { getDeltaContent: () => 'third-also-skipped' }
    ]));
    const res = fakeRes();
    await streamChat({
      res, system: 's', messages: [{ role: 'user', content: 'hi' }],
      deploymentId: 'd1', signal: ac.signal
    });
    const joined = res.chunks.join('');
    // The first delta (emitted before abort) should be present.
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"first"/);
    // The third chunk should never be emitted (abort breaks the stream loop).
    expect(joined).not.toMatch(/third-also-skipped/);
    // No done frame on abort — client is gone.
    expect(joined).not.toMatch(/"type":"done"/);
    // res.end() still runs via finally.
    expect(res.ended).toBe(true);
  });

  it('emits a tutorial-cards SSE event after searchTutorials returns hits', async () => {
    const searchRun = vi.fn().mockResolvedValue([
      { slug: 'a', title: 'A', description: 'desc', type: 'tutorial', primaryTag: 'cap' }
    ]);
    connectMock.mockResolvedValue({ run: searchRun, entities: {} });

    streamMock.mockReturnValueOnce(makeResponse(
      [{ getDeltaContent: () => null }],
      [{ id: 't1', function: { name: 'searchTutorials', arguments: '{"query":"cap"}' } }]
    ));
    streamMock.mockReturnValueOnce(makeResponse(
      [{ getDeltaContent: () => 'ok' }]
    ));

    const res = fakeRes();
    await streamChat({ res, system: 's', messages: [{ role: 'user', content: 'find cap' }], deploymentId: 'd1' });

    const joined = res.chunks.join('');
    expect(joined).toMatch(/"type":"tutorial-cards"/);
    expect(joined).toMatch(/"slug":"a"/);
  });
});
