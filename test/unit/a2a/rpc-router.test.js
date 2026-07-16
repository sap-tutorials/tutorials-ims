// test/unit/a2a/rpc-router.test.js
// JSON-RPC router tests. Uses Node's built-in fetch + http.createServer (no
// supertest — project avoids that dep). Pattern mirrors test/unit/advocate-user-link.test.js.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

let currentUser = { id: 'u1', attr: {}, is: () => false };
const store = new Map();

vi.mock('@sap/cds', () => ({
  default: {
    context: { get user() { return currentUser; } },
    connect: { to: vi.fn(async () => ({})) },
    entities: () => ({ ChatSettings: 'ChatSettings' }),
    log: () => ({ warn(){}, error(){}, info(){}, debug(){} }),
  },
}));

vi.mock('../../../srv/lib/a2a/skills.js', () => {
  class A2aError extends Error {
    constructor(code, msg) { super(msg); this.code = code; }
  }
  return {
    A2aError,
    resolveSkillId: (message, params) => params?.metadata?.skillId || message?.metadata?.skillId || 'tutorial-chat',
    runToolSkill: vi.fn(async ({ skillId }) => ({ ok: skillId })),
    runChatSkillStream: vi.fn(async ({ res }) => {
      res.write('data: {"kind":"status-update","status":{"state":"completed"},"final":true}\n\n');
      if (typeof res.end === 'function') res.end();
    }),
  };
});

vi.mock('../../../srv/lib/a2a/task-store.js', () => ({
  getTask: vi.fn(async (id) => store.get(id) ?? null),
  cancelTask: vi.fn(async (id) => (store.has(id) ? { id, state: 'canceled' } : null)),
  putTask: vi.fn(async (id, s) => { store.set(id, s); }),
  newTaskId: () => 'task-fixed',
}));

// FIX 1: mock the rate limiter. The default mock allows all calls; individual
// tests override with mockImplementationOnce to simulate exceeded limits.
vi.mock('../../../srv/lib/chat-rate-limit.js', () => {
  class RateLimitError extends Error {
    constructor() { super('rate limit'); this.retryAfterSec = 60; }
  }
  const check = vi.fn(() => { /* pass by default */ });
  return {
    RateLimitError,
    createRateLimiter: () => ({ check }),
    _getCheckMock: () => check,
  };
});

// readChatSettings is internal; make SELECT resolve a valid enabled settings row.
globalThis.SELECT = {
  one: { from: () => ({ where: async () => ({ enabled: true, deploymentId: 'd1', maxRequestsPerUser: 100 }) }) },
};

import { makeA2aRouter } from '../../../srv/lib/a2a/rpc-router.js';
import { runChatSkillStream } from '../../../srv/lib/a2a/skills.js';
import { _getCheckMock } from '../../../srv/lib/chat-rate-limit.js';

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/a2a', makeA2aRouter());
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise((resolve) => server?.close(resolve)));

function post(body) {
  return fetch(`${baseUrl}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a2a rpc-router', () => {
  beforeEach(() => {
    currentUser = { id: 'u1', attr: {}, is: () => false };
    store.clear();
    delete process.env.A2A_ENABLED;
    // Reset rate-limit mock to pass by default.
    _getCheckMock().mockReset();
    _getCheckMock().mockImplementation(() => { /* pass */ });
  });

  it('rejects anonymous with -32001 (401)', async () => {
    currentUser = { id: 'anonymous' };
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('503 when A2A_ENABLED=false', async () => {
    process.env.A2A_ENABLED = 'false';
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    expect(res.status).toBe(503);
  });

  it('unknown method → -32601', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'bogus/method', params: {} });
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  it('message/send tool skill returns a completed task result', async () => {
    const res = await post({
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: {
        message: { role: 'user', parts: [{ kind: 'text', text: 'CAP' }] },
        metadata: { skillId: 'search-tutorials' },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.status.state).toBe('completed');
  });

  it('tasks/get returns stored snapshot for the owning user', async () => {
    store.set('t9', { id: 't9', state: 'working', userId: 'u1' });
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: 't9' } });
    const body = await res.json();
    expect(body.result.state).toBe('working');
  });

  it('tasks/get unknown → -32602', async () => {
    const res = await post({ jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: 'ghost' } });
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });

  it('tasks/cancel marks canceled', async () => {
    store.set('t8', { id: 't8', state: 'working', userId: 'u1' });
    const res = await post({ jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { id: 't8' } });
    const body = await res.json();
    expect(body.result.state).toBe('canceled');
  });

  it('routes POST /a2a when the router is invoked directly as a handler (server.js pattern)', async () => {
    const directApp = express();
    directApp.use(express.json());
    const r = makeA2aRouter();
    directApp.post('/a2a', (req, res, next) => r(req, res, next)); // direct invoke, prefix NOT stripped
    directApp.use((req, res) => res.status(404).json({ fell_through: true }));
    const srv = http.createServer(directApp);
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/a2a`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 't9' } }),
      });
      // With the bug this would be 404 {fell_through:true}. With the fix it reaches
      // the router (tasks/get on unknown id → JSON-RPC -32602, HTTP 200).
      const body = await resp.json();
      expect(body.fell_through).toBeUndefined();
      expect(body.error?.code).toBe(-32602);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('message/send chat skill accumulates streamed text from A2A status-update frames', async () => {
    // Override runChatSkillStream for this test to emit realistic shim output:
    // two working status-update frames with text parts, then a final completed frame.
    runChatSkillStream.mockImplementationOnce(async ({ res }) => {
      res.write('data: ' + JSON.stringify({
        kind: 'status-update', final: false,
        status: { state: 'working', message: { role: 'agent', parts: [{ kind: 'text', text: 'Hello ' }] } },
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        kind: 'status-update', final: false,
        status: { state: 'working', message: { role: 'agent', parts: [{ kind: 'text', text: 'world' }] } },
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        kind: 'status-update', final: true,
        status: { state: 'completed' },
      }) + '\n\n');
    });

    const res = await post({
      jsonrpc: '2.0', id: 6, method: 'message/send',
      // No skillId → resolves to 'tutorial-chat' (the buffered path).
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // terminalTaskEvent wraps accumulated text in status.message.parts[0].text.
    expect(body.result.status.message.parts[0].text).toBe('Hello world');
  });

  // FIX 1: rate-limit returns 429 / -32005 when the limiter throws RateLimitError.
  it('message/send returns 429/-32005 when rate limit exceeded', async () => {
    const { RateLimitError } = await import('../../../srv/lib/chat-rate-limit.js');
    _getCheckMock().mockImplementationOnce(() => { throw new RateLimitError(); });

    const res = await post({
      jsonrpc: '2.0', id: 7, method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe(-32005);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  // FIX 4 (IDOR): tasks/get for a task owned by a different user → -32602.
  it('tasks/get for task owned by different user returns -32602', async () => {
    // Store a task owned by 'other-user', not 'u1'.
    store.set('t-other', { id: 't-other', state: 'completed', userId: 'other-user' });
    const res = await post({ jsonrpc: '2.0', id: 8, method: 'tasks/get', params: { id: 't-other' } });
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
    // Must not leak the task state.
    expect(body.result).toBeUndefined();
  });

  // FIX 2: buffered message/send collects artifact-update frames into result.artifacts.
  it('message/send collects artifact-update frames into result.artifacts', async () => {
    runChatSkillStream.mockImplementationOnce(async ({ res }) => {
      // Emit a working text frame.
      res.write('data: ' + JSON.stringify({
        kind: 'status-update', final: false,
        status: { state: 'working', message: { role: 'agent', parts: [{ kind: 'text', text: 'see cards' }] } },
      }) + '\n\n');
      // Emit an artifact-update frame (already-mapped A2A event).
      res.write('data: ' + JSON.stringify({
        kind: 'artifact-update',
        artifact: { name: 'tutorial-cards', parts: [{ kind: 'data', data: { type: 'tutorial-cards', cards: [{ slug: 'cap-start' }] } }] },
      }) + '\n\n');
      // Terminal frame.
      res.write('data: ' + JSON.stringify({
        kind: 'status-update', final: true, status: { state: 'completed' },
      }) + '\n\n');
    });

    const res = await post({
      jsonrpc: '2.0', id: 9, method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'find me tutorials' }] } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.result.artifacts)).toBe(true);
    expect(body.result.artifacts.length).toBeGreaterThan(0);
    expect(body.result.artifacts[0].name).toBe('tutorial-cards');
  });
});
