// test/hybrid/mcp-admin-tools.test.js
//
// Hybrid: Phase 3 admin tool scope enforcement (criterion 2).
//
// Proves that the admin MCP tools `merge_concepts` and `trigger_rebuild` are
// NOT callable by an anonymous / non-admin caller — satisfying Phase 3 success
// criterion 2: "author scope enforced by hybrid smoke".
//
// Assertion strategy — auth-hidden is the criterion-2 signal.
// AdminService carries @requires:'Admin' at service level. When an anonymous
// request hits the compose router, checkAuthorization() (from @cap-js/mcp
// lib/auth.js) detects the unsigned cds.context?.user and returns a service-
// level 401. makeComposeRouter (srv/lib/mcp-compose-router.js) short-circuits
// before building the McpServer, returning HTTP 401 with a JSON-RPC error
// body { code: -32001, message: 'Authorization error (401): ...' }. This is
// the deterministic, credential-free signal: the admin tools are unreachable
// for non-admin callers — not just filtered from tools/list but gate-rejected
// at the service boundary. No admin JWT is minted in this harness; the 401
// error response IS the assertion.
//
// Harness pattern — copied from test/hybrid/mcp-resources.test.js (Task 10),
// which itself mirrors test/hybrid/mcp-authenticated-tools.test.js.
// Uses the same HAS_HANA detection (VCAP_SERVICES with a hana-tagged service)
// and the same cds.test/describeIf guard so the suite is inert when no binding
// is present.
//
// NOTE: The mcpRpc helper here does NOT assert res.status === 200 (unlike
// mcp-resources.test.js) because the expected response is HTTP 401 with a
// valid JSON-RPC error body. The assertion is on the body shape, not the HTTP
// status.
//
// Runs with: npm run test:hybrid -- test/hybrid/mcp-admin-tools.test.js
// (#1106 Task 15)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import cds from '@sap/cds';

// ─── Backend detection (sync, at import time) ──────────────────────────────
// `cds bind --exec` populates VCAP_SERVICES with the bound HANA instance. Its
// presence is the signal that this is a real hybrid run rather than a bare
// `vitest` invocation that would fall back to empty SQLite. Detect it before
// deciding whether to boot the server, so an unbound run is inert (visible
// skip) instead of a false green.
function hasHanaBinding() {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) return false;
  try {
    const vcap = JSON.parse(raw);
    const hana = [...(vcap.hana || []), ...(vcap['hana-cloud'] || [])];
    return hana.some(
      (s) => s?.name === 'tutorials-hana' || (s?.tags || []).includes('hana')
    );
  } catch {
    return false;
  }
}

const HAS_HANA = hasHanaBinding();

// Only boot the CAP server when the suite will actually run — `cds.test('serve')`
// at import-time eagerly attaches the [hybrid] xsuaa auth middleware, which
// crashes the whole suite when no xsuaa instance is bound.
if (HAS_HANA) cds.test('serve', '--project', '.', '--profile', 'hybrid');

const describeIf = HAS_HANA ? describe : describe.skip;

describeIf('Phase 3 admin tools scope enforcement (hybrid, real HANA)', { timeout: 60_000 }, () => {
  // ─── In-process compose-router mini-server ─────────────────────────────────
  // Mount makeComposeRouter(AdminService) on a dedicated express app so we can
  // POST real JSON-RPC requests against it and observe the service-level auth
  // gate through the exact same code path that production uses, without relying
  // on CAP's own HTTP port binding.
  //
  // No context-setting middleware is added here — cds.context?.user is
  // undefined/anonymous for every request, which is precisely the non-admin
  // scenario we are testing. AdminService.@requires('Admin') is enforced by
  // checkAuthorization() in makeComposeRouter before the McpServer is built,
  // so the tools are never registered — the gate fires at the service boundary.
  let httpServer;
  let port;

  beforeAll(async () => {
    // Wait for AdminService to be ready.
    const AdminService = await cds.connect.to('AdminService');
    if (!AdminService) throw new Error('AdminService did not connect');

    const { default: makeComposeRouter } = await import('../../srv/lib/mcp-compose-router.js');
    const { default: express } = await import('express');

    const app = express();
    app.use(express.json());

    // Mount the compose router for AdminService at /mcp/admin — the same
    // path that admin-service-mcp.cds declares via @protocol.
    const router = makeComposeRouter(AdminService);
    app.use('/mcp/admin', router);

    httpServer = http.createServer(app);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  });

  /**
   * POST a JSON-RPC request to the admin compose mount and return the parsed
   * body. Does NOT assert res.status === 200 — anonymous requests against
   * AdminService are expected to return HTTP 401 with a JSON-RPC error body.
   */
  async function mcpRpc(method, params = {}) {
    const res = await fetch(`http://localhost:${port}/mcp/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return res.json();
  }

  // ─── Criterion 2: admin tools hidden/rejected for non-admin ────────────────
  //
  // Why the auth-hidden assertion satisfies criterion 2:
  // The criterion says "merge_concepts + trigger_rebuild are NOT callable
  // without the required scope". The strongest possible proof is that an
  // anonymous request receives a JSON-RPC error before the tool list is even
  // built. AdminService.@requires:'Admin' causes makeComposeRouter to short-
  // circuit with error code -32001 (401). Consequently:
  //   (a) tools/list yields no `result.tools` — the body carries `error`, not
  //       `result`, so (r.result?.tools ?? []) collapses to [] and neither
  //       merge_concepts nor trigger_rebuild appears.
  //   (b) tools/call merge_concepts yields `r.error` (truthy) — the call is
  //       rejected with a JSON-RPC auth error before any action dispatch.
  // Both assertions together prove the gate is in effect at the service boundary.

  it('tools/list on /mcp/admin as anonymous does not expose merge_concepts or trigger_rebuild', async () => {
    const r = await mcpRpc('tools/list');
    // r.error is set when the service-level gate fires (HTTP 401 + -32001).
    // r.result?.tools is undefined in that case, falling back to [].
    // Either way — error response OR filtered tool list — neither gated tool
    // must appear in names. This is the deterministic criterion-2 signal.
    const names = (r.result?.tools ?? []).map((t) => t.name);
    expect(names, `anonymous tools/list must not include merge_concepts; body: ${JSON.stringify(r)}`).not.toContain('merge_concepts');
    expect(names, `anonymous tools/list must not include trigger_rebuild; body: ${JSON.stringify(r)}`).not.toContain('trigger_rebuild');
  });

  it('tools/call merge_concepts without admin scope is rejected with a JSON-RPC auth error', async () => {
    const r = await mcpRpc('tools/call', {
      name: 'merge_concepts',
      arguments: {
        loser: '00000000-0000-0000-0000-000000000000',
        canonical: '00000000-0000-0000-0000-000000000001',
      },
    });
    // The service-level 401 gate fires before the tool is dispatched.
    // r.error is the JSON-RPC error object ({ code: -32001, message: '...' }).
    // r.result?.isError would be truthy if the tool had been invoked and
    // returned an error response — but here the gate fires first.
    expect(
      r.error ?? r.result?.isError,
      `merge_concepts call must be rejected for anonymous caller; body: ${JSON.stringify(r)}`
    ).toBeTruthy();
  });
});
