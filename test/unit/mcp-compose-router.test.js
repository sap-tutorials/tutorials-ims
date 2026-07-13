// test/unit/mcp-compose-router.test.js
import { expect, describe, it, vi, beforeEach } from 'vitest';

// The compose router registers prompts capability + resources capability alongside tools.
// We unit-test the capability wiring by invoking the exported buildServer() with fakes,
// NOT by standing up HTTP (that's the contract/hybrid layer's job).
import { buildServer, flags } from '../../srv/lib/mcp-compose-router.js';

describe('mcp-compose-router capability wiring', () => {
  beforeEach(() => {
    delete process.env.MCP_RESOURCES_ENABLED;
    delete process.env.MCP_PROMPTS_ENABLED;
  });

  it('flags default all enabled', () => {
    expect(flags()).toEqual({ phase3: true, resources: true, prompts: true, adminTools: true });
  });

  it('buildServer advertises tools + resources + prompts capabilities by default', async () => {
    const caps = {};
    const server = {
      registerResource: vi.fn(),
      server: { registerCapabilities: (c) => Object.assign(caps, c), setRequestHandler: vi.fn() },
    };
    const srv = { name: 'KnowledgeGraphService', definition: {} };
    await buildServer(server, srv, { entities: {}, actions: {} }, {
      // inject fakes so no adapter/db needed
      registerTools: vi.fn(),
      registerResourcesFn: (s) => s.registerResource('tutorial', {}, {}, () => {}),
      promptMap: new Map([['p', { name: 'p', description: 'x', arguments: [], template: 't' }]]),
    });
    expect(caps.tools).toEqual({ listChanged: false });
    expect(caps.resources).toEqual({ subscribe: false, listChanged: false });
    expect(caps.prompts).toEqual({ listChanged: false });
    expect(server.registerResource).toHaveBeenCalled();
  });

  it('omits resources capability when MCP_RESOURCES_ENABLED=false', async () => {
    process.env.MCP_RESOURCES_ENABLED = 'false';
    const caps = {};
    const server = { registerResource: vi.fn(), server: { registerCapabilities: (c) => Object.assign(caps, c), setRequestHandler: vi.fn() } };
    await buildServer(server, { name: 'X', definition: {} }, { entities: {}, actions: {} }, {
      registerTools: vi.fn(), registerResourcesFn: vi.fn(), promptMap: new Map(),
    });
    expect(caps.resources).toBeUndefined();
    expect(caps.tools).toEqual({ listChanged: false });
  });
});
