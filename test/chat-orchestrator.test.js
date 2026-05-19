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

describe('chat-orchestrator', () => {
  beforeEach(() => {
    streamMock.mockReset();
    connectMock.mockReset();
  });

  it('emits delta SSE events and a done event for plain text', async () => {
    streamMock.mockReturnValueOnce(makeStream([
      { getDeltaContent: () => 'Hel', getToolCalls: () => null },
      { getDeltaContent: () => 'lo', getToolCalls: () => null }
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
    connectMock.mockResolvedValue({ run: searchRun });

    streamMock.mockReturnValueOnce(makeStream([
      {
        getDeltaContent: () => null,
        getToolCalls: () => [{ id: 't1', name: 'searchTutorials', args: { query: 'cap' } }]
      }
    ]));
    streamMock.mockReturnValueOnce(makeStream([
      { getDeltaContent: () => 'Found it', getToolCalls: () => null }
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
    connectMock.mockResolvedValue({ run: searchRun });
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
    connectMock.mockResolvedValue({ run: vi.fn().mockResolvedValue([]) });
    streamMock.mockReturnValue(makeStream([
      { getDeltaContent: () => null, getToolCalls: () => [{ id: 'x', name: 'searchTutorials', args: { query: 'q' } }] }
    ]));
    const res = fakeRes();
    await streamChat({ res, system: 's', messages: [{ role: 'user', content: 'q' }], deploymentId: 'd1' });
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(res.ended).toBe(true);
  });
});
