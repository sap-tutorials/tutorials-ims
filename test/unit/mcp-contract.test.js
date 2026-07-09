// test/unit/mcp-contract.test.js
//
// MCP protocol contract test — verifies that the 8 Phase 1 curated tools PLUS
// the 1 Phase 2 anonymous tool (SearchService.get_tutorial_step) are
// discoverable via `tools/list` with non-empty descriptions and valid
// JSON-Schema inputSchema objects.
//
// Architecture notes
// ──────────────────
// 1. @cap-js/mcp cds-plugin.js registers the 'mcp' protocol in
//    `cds.service.protocols` at module-load time. The plugin is activated
//    automatically by `cds.deploy()` (via `await cds.plugins`), so we do NOT
//    need to import the plugin explicitly. The MCP adapter is instantiated
//    directly (`@cap-js/mcp/lib/index.js`) so that only the three @mcp
//    services are served over HTTP — the full `cds.server()` bootstrap is
//    avoided because CronService.init() crashes on the unit-test SQLite
//    schema (no JobLastRun table needed by the CAP scheduling API).
//
// 2. `cds.mcp.per_action_tool: true` is set in package.json so each CDS
//    function appears as its own named MCP tool with its exact snake_case
//    name (default is a single generic `call_action` tool).
//
// 3. The MCP adapter returns plain JSON when `Accept: application/json` is
//    sent without `text/event-stream`. The SSE guard in mcpPost() handles
//    any adapters that still emit SSE.
//
// 4. @odata is added to the @mcp-annotated services (srv/*.cds) so they
//    retain their OData endpoints alongside the new MCP endpoints. Without
//    @odata, CAP's protocol resolver treats @mcp as an exclusive annotation
//    and drops the default OData protocol — breaking existing HTTP tests.
//
// MCP service mount paths (from @path annotations):
//   SearchService         → /search
//   HomepageService       → /homepage
//   KnowledgeGraphService → /graph
//
// Phase 2 auth-enumeration finding (#1105 Task 14)
// ─────────────────────────────────────────────────
// @cap-js/mcp HIDES auth-gated tools from an unauthenticated tools/list.
// The adapter's checkAuthorization() in lib/auth.js filters actions/functions
// by @requires at request-time; when cds.context?.user is anonymous, every
// function/action annotated @(requires: 'authenticated-user') is excluded
// from the actions map and therefore never registered. This means the 9
// authenticated Phase 2 tools (7 × DeveloperService + 2 × HomepageService)
// cannot be asserted here — they are correctly auth-hidden in this unit
// context. Their enumeration under a real JWT is verified in the hybrid/smoke
// layer (Task 17 / test/smoke). Only the anonymous Phase 2 tool
// (SearchService.get_tutorial_step, @requires: 'any') enumerates here.
//
// (#912 Task 11, #1105 Task 14)

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import cds from '@sap/cds';

// ─── Constants ────────────────────────────────────────────────────────────────

const CURATED_TOOLS = {
  SearchService: ['search_tutorials', 'list_missions', 'get_mission', 'get_tutorial'],
  HomepageService: ['get_recent_news', 'get_recent_videos'],
  KnowledgeGraphService: ['kg_prerequisites', 'kg_what_to_learn_next'],
};

// Expected CDS function parameters per curated tool.
// These must appear as keys in tool.inputSchema.properties.
const EXPECTED_PARAMS = {
  search_tutorials:      ['query', 'tags', 'experience', 'limit'],
  list_missions:         ['tags', 'limit'],
  get_mission:           ['slug'],
  get_tutorial:          ['slug'],
  get_recent_news:       ['limit'],
  get_recent_videos:     ['limit'],
  kg_prerequisites:      ['tutorial_slug', 'depth'],
  kg_what_to_learn_next: ['tutorial_slug', 'limit'],
};

// Phase 2 anonymous tools — enumerable without auth (SearchService @requires:'any').
// The 9 authenticated tools (7×DeveloperService + 2×HomepageService, all
// @requires:'authenticated-user') are auth-hidden at this layer; they are
// verified in the hybrid/smoke layer (Task 17). See the top-of-file auth-
// enumeration finding comment for the full explanation.
const PHASE2_ANONYMOUS_TOOLS = [
  { service: 'SearchService', name: 'get_tutorial_step', params: ['slug', 'stepNumber'] },
];

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let httpServer;
// Map: serviceName → MCP adapter mount path (e.g. '/search')
let serviceEndpoints = {};

beforeAll(async () => {
  // ── 1. Deploy schema to in-memory SQLite ────────────────────────────────
  //       cds.deploy() also calls `await cds.plugins` which loads @cap-js/mcp
  //       and registers `protocols.mcp` — no explicit plugin import needed.
  process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';
  await cds.deploy([
    path.join(process.cwd(), 'db'),
    path.join(process.cwd(), 'srv'),
  ]).to('sqlite::memory:');

  // ── 2. Serve only the three @mcp services individually ──────────────────
  //       We avoid cds.server('all') to skip CronService, which crashes in
  //       init() on the unit-test SQLite schema (no JobLastRun table).
  const searchSrv = await cds.serve('SearchService').from('./srv');
  const homeSrv   = await cds.serve('HomepageService').from('./srv');
  const kgSrv     = await cds.serve('KnowledgeGraphService').from('./srv');

  // ── 3. Instantiate the MCP adapter directly for each service ────────────
  //       This bypasses the full CAP protocol-routing machinery so that only
  //       the MCP router is exposed over HTTP — no OData, no WebSocket.
  const McpAdapter = (await import('@cap-js/mcp/lib/index.js')).default;
  const { default: express } = await import('express');

  const app = express();
  app.use(express.json());

  for (const srv of [searchSrv, homeSrv, kgSrv]) {
    // Derive mount path from @path annotation or slugified service name.
    const svcPath = srv.definition?.['@path'] ?? `/${srv.name.toLowerCase()}`;
    const router = McpAdapter(srv);
    if (router) {
      app.use(svcPath, router.router ?? router);
      serviceEndpoints[srv.name] = svcPath;
    }
  }

  // ── 4. Start the HTTP server on an ephemeral port ────────────────────────
  httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, r));
}, 60_000);

afterAll(async () => {
  // Close HTTP server and release the DB connection.
  await new Promise((r) => httpServer?.close(r));
  await cds.disconnect();

  // Purge service instances added by this test so subsequent tests that use
  // cds.test('serve') or cds.connect.to() get fresh instances rather than
  // the stale ones bound to this test's in-memory SQLite DB.
  for (const svcName of [...Object.keys(CURATED_TOOLS), 'db']) {
    delete cds.services[svcName];
  }
  delete cds.db;
  delete cds.model;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** POST a JSON-RPC request to the given MCP service path. Returns parsed body. */
async function mcpPost(svcPath, body) {
  const { port } = httpServer.address();
  const res = await fetch(`http://localhost:${port}${svcPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Pure JSON Accept → adapter uses JSON response mode (no SSE wrapping).
      'accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Guard: if the adapter returned SSE, extract the last data line.
  if (text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    return JSON.parse(dataLines[dataLines.length - 1] ?? '{}');
  }
  return JSON.parse(text);
}

/** Fetch tools/list for a service. Returns the tools array. */
async function listTools(serviceName) {
  const svcPath = serviceEndpoints[serviceName];
  if (!svcPath) throw new Error(`No MCP adapter registered for ${serviceName}`);
  const body = await mcpPost(svcPath, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return body?.result?.tools ?? [];
}

// ─── Contract assertions ──────────────────────────────────────────────────────

describe('MCP protocol contract', () => {
  it('MCP adapters mounted for all three services', () => {
    for (const svcName of Object.keys(CURATED_TOOLS)) {
      expect(
        serviceEndpoints[svcName],
        `Expected ${svcName} to have an MCP adapter mounted`
      ).toBeTruthy();
    }
  });

  for (const [service, toolNames] of Object.entries(CURATED_TOOLS)) {
    describe(service, () => {
      let toolList;

      beforeAll(async () => {
        toolList = await listTools(service);
      });

      it('tools/list returns a non-empty array', () => {
        expect(Array.isArray(toolList)).toBe(true);
        expect(toolList.length).toBeGreaterThan(0);
      });

      for (const toolName of toolNames) {
        describe(`tool: ${toolName}`, () => {
          let tool;

          beforeAll(() => {
            tool = toolList.find((t) => t.name === toolName);
          });

          it(`is enumerated by tools/list`, () => {
            expect(tool, `${toolName} not found in ${service} tool list`).toBeDefined();
          });

          it(`has a non-trivial description (>20 chars)`, () => {
            expect(typeof tool?.description).toBe('string');
            expect(
              tool?.description?.length,
              `${toolName} description is too short — add a /** */ doc-comment to the CDS function`
            ).toBeGreaterThan(20);
          });

          it(`has a valid JSON-Schema inputSchema`, () => {
            expect(tool?.inputSchema).toBeDefined();
            expect(tool?.inputSchema?.type).toBe('object');
            expect(tool?.inputSchema?.properties).toBeDefined();
          });

          it(`declares all expected CDS parameters in inputSchema.properties`, () => {
            const props = Object.keys(tool?.inputSchema?.properties ?? {});
            for (const param of EXPECTED_PARAMS[toolName] ?? []) {
              expect(
                props,
                `${toolName}: CDS parameter '${param}' missing from inputSchema.properties`
              ).toContain(param);
            }
          });
        });
      }
    });
  }
});

// ─── Phase 2 contract assertions ─────────────────────────────────────────────
//
// Only anonymous Phase 2 tools are asserted here. The 9 authenticated tools
// (DeveloperService: get_my_tutorials, get_my_missions, get_my_events,
//  get_my_completed_steps, get_tutorial_step, complete_step, reset_tutorial_progress;
//  HomepageService: get_my_recommended_tutorials, get_my_recommended_missions)
// are correctly hidden from an unauthenticated tools/list by @cap-js/mcp's
// auth.js checkActionAccess() — they are verified in the hybrid/smoke layer
// (Task 17).

describe('Phase 2 MCP tools (anonymous)', () => {
  for (const { service, name: toolName, params } of PHASE2_ANONYMOUS_TOOLS) {
    describe(`${service}.${toolName}`, () => {
      let tool;

      beforeAll(async () => {
        const tools = await listTools(service);
        tool = tools.find((t) => t.name === toolName);
      });

      it('is enumerated by tools/list (anonymous)', () => {
        expect(tool, `${toolName} not found in ${service} tool list — check @requires:'any' annotation`).toBeDefined();
      });

      it('has a non-trivial description (>=40 chars, no boilerplate)', () => {
        expect(typeof tool?.description).toBe('string');
        expect(
          tool?.description?.length,
          `${toolName} description is too short (<40 chars) — extend the /** */ doc-comment in srv/search-service-mcp.cds`
        ).toBeGreaterThanOrEqual(40);
        expect(tool?.description, `${toolName} description must not start with TODO`).not.toMatch(/^\s*TODO/i);
        expect(tool?.description, `${toolName} description must not contain 'function that'`).not.toMatch(/function that/i);
      });

      it('has a valid JSON-Schema inputSchema of type object with properties', () => {
        expect(tool?.inputSchema).toBeDefined();
        expect(tool?.inputSchema?.type).toBe('object');
        expect(
          tool?.inputSchema?.properties,
          `${toolName}: inputSchema.properties must be defined and non-empty`
        ).toBeDefined();
        expect(Object.keys(tool?.inputSchema?.properties ?? {}).length).toBeGreaterThan(0);
      });

      it('declares all expected CDS parameters in inputSchema.properties', () => {
        const props = Object.keys(tool?.inputSchema?.properties ?? {});
        for (const param of params) {
          expect(
            props,
            `${toolName}: CDS parameter '${param}' missing from inputSchema.properties`
          ).toContain(param);
        }
      });

      it('carries readOnlyHint annotation (function kind)', () => {
        expect(tool?.annotations?.readOnlyHint).toBe(true);
      });
    });
  }
});
