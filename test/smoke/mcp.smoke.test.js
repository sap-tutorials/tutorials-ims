// test/smoke/mcp.smoke.test.js
//
// Deployed-target smoke for the /mcp/* surface. Two canaries against the
// approuter URL: `initialize` returns 200 and `search_tutorials` returns
// a non-empty result envelope.
//
// Skipped when SMOKE_BASE_URL is unset (see test/smoke/smoke.config.js).
// Runs with: `SMOKE_BASE_URL=<url> npm run test:smoke -- test/smoke/mcp.smoke.test.js`
//
// (#912 Task 14)

import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

const SMOKE_TARGET = process.env.SMOKE_BASE_URL;
const describeIf = SMOKE_TARGET ? describe : describe.skip;

// The MCP adapter mounts services under `/mcp/<@path>` — so `/mcp/search`
// for SearchService (@path '/search'). See docs/developers/reference/mcp-server.md.
const MCP_SEARCH = '/mcp/search';

async function mcpFetch(pathAndQuery, body) {
  return fetchWithRetry(`${BASE_URL}${pathAndQuery}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // JSON-only Accept → adapter uses JSON response mode (no SSE frame).
      'accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describeIf('MCP smoke — deployed target', { timeout: 20_000 }, () => {
  it('initialize on /mcp/search returns 200', async () => {
    const res = await mcpFetch(MCP_SEARCH, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06',
        capabilities: {},
        clientInfo: { name: 'ims-smoke', version: '1' },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Adapter must echo the JSON-RPC envelope and expose a serverInfo block.
    expect(body?.result?.serverInfo?.name).toBeDefined();
  });

  it('tools/list exposes search_tutorials on /mcp/search', async () => {
    const res = await mcpFetch(MCP_SEARCH, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const tools = body?.result?.tools ?? [];
    const names = tools.map(t => t.name);
    expect(names, `expected search_tutorials in ${JSON.stringify(names)}`).toContain('search_tutorials');
  });

  it('tools/call search_tutorials returns a non-empty result for a canary query', async () => {
    const res = await mcpFetch(MCP_SEARCH, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_tutorials', arguments: { query: 'CAP', limit: 3 } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // MCP `tools/call` returns { content: [{type: 'text', text: '...'}] } —
    // the text payload holds the tool's return value (JSON or TOON depending
    // on cds.mcp.toon_format). We just assert content exists and is non-empty.
    const content = body?.result?.content ?? [];
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    // At least one entry must carry a string payload — no empty content array.
    const firstText = content[0]?.text ?? content[0]?.data ?? '';
    expect(typeof firstText === 'string' && firstText.length).toBeGreaterThan(0);
  });
});
