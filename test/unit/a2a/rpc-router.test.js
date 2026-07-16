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

// readChatSettings is internal; make SELECT resolve a valid enabled settings row.
globalThis.SELECT = {
  one: { from: () => ({ where: async () => ({ enabled: true, deploymentId: 'd1' }) }) },
};

import { makeA2aRouter } from '../../../srv/lib/a2a/rpc-router.js';
import { runChatSkillStream } from '../../../srv/lib/a2a/skills.js';

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

  it('tasks/get returns stored snapshot', async () => {
    store.set('t9', { id: 't9', state: 'working' });
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
    store.set('t8', { id: 't8', state: 'working' });
    const res = await post({ jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { id: 't8' } });
    const body = await res.json();
    expect(body.result.state).toBe('canceled');
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
});
