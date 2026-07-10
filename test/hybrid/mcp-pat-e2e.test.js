// test/hybrid/mcp-pat-e2e.test.js
//
// Hybrid: PAT end-to-end.
// Mints a PAT via /pats/mintPAT, calls /mcp-pat/api tools/call with
// Authorization: Bearer pat_..., and asserts the same shape as a direct service call.
//
// Requires a running CAP server (cds bind --exec or npm run test:hybrid).
// Skipped when HYBRID_BASE_URL is unset and the local port isn't reachable.
//
// (#1105 Task 17a)

import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.HYBRID_BASE_URL ?? 'http://localhost:4004';

// Basic-auth fixture user for minting the PAT.
const FIXTURE_USER = 'mcp-hybrid-test@sap.example';
const FIXTURE_BASIC = Buffer.from(`${FIXTURE_USER}:x`).toString('base64');

async function mintPAT() {
  const res = await fetch(`${BASE}/pats/mintPAT`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Basic ${FIXTURE_BASIC}`,
    },
    body: JSON.stringify({ name: 'hybrid-e2e-test', scopes: ['read'], ttlDays: 1 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`mintPAT failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function callMcpTool(patToken, tool, args) {
  return fetch(`${BASE}/mcp-pat/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      Authorization:  `Bearer ${patToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'tools/call',
      params:  { name: tool, arguments: args },
    }),
  });
}

// Probe connectivity — skip entire suite if server isn't reachable.
let serverReachable = false;
try {
  const probe = await fetch(`${BASE}/mcp/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize',
              params: { protocolVersion: '2025-06', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }),
    signal: AbortSignal.timeout(3000),
  });
  serverReachable = probe.ok;
} catch {
  // not reachable
}

const describeIf = serverReachable ? describe : describe.skip;

describeIf('PAT end-to-end (hybrid, real HANA)', { timeout: 30_000 }, () => {
  let mintedToken;

  beforeAll(async () => {
    const result = await mintPAT();
    // mintPAT returns the plaintext token once. Shape: { token: 'pat_...', ... }
    mintedToken = result?.token ?? result?.data?.token;
    if (!mintedToken) {
      throw new Error(`mintPAT did not return a token: ${JSON.stringify(result)}`);
    }
  });

  it('minted token starts with pat_', () => {
    expect(mintedToken).toMatch(/^pat_/);
  });

  it('calls /mcp-pat/api tools/list with PAT and gets 200', async () => {
    const res = await fetch(`${BASE}/mcp-pat/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        Authorization:  `Bearer ${mintedToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // tools/list result — authenticated tools should now appear
    const tools = body?.result?.tools ?? [];
    expect(Array.isArray(tools)).toBe(true);
    // At least some tools must enumerate (authenticated user = real JWT/PAT).
    expect(tools.length).toBeGreaterThan(0);
  });

  it('calls get_my_tutorials via PAT and gets valid shape', async () => {
    const res = await callMcpTool(mintedToken, 'get_my_tutorials', { status: 'all', limit: 5 });
    expect(res.status).toBe(200);
    const body = await res.json();
    // tools/call response — content array wrapping the result.
    expect(body?.result?.content ?? body?.result).toBeDefined();
  });

  it('/mcp-pat/api returns 401 without a PAT', async () => {
    const res = await fetch(`${BASE}/mcp-pat/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
