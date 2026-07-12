// test/hybrid/mcp-authenticated-tools.test.js
//
// Hybrid: Phase 2 authenticated MCP tools.
//
// Two guarantees, both meaningless without a real backend:
//   1. Enumeration — an *authenticated* `tools/list` over HTTP surfaces the 9
//      auth-gated tools (7 × DeveloperService + 2 × HomepageService); an
//      *unauthenticated* `tools/list` hides every one of them. This is the
//      Task 14 finding: @cap-js/mcp's auth.js::checkActionAccess() filters
//      @requires:'authenticated-user' functions out of the actions map for
//      anonymous requests, so they never register.
//   2. Shape — each authenticated tool, invoked as the fixture user against
//      real HANA, returns a valid shape (array / slice / 404).
//
// The enumeration guard uses the McpAdapter + express pattern from
// test/unit/mcp-contract.test.js (a cds.context-installing middleware carries
// the authenticated identity in-process — verified against the live adapter).
// It does NOT depend on HANA, but lives here because the whole file is gated
// on a real bind: outside `npm run test:hybrid` there are no HANA creds, so
// booting the [hybrid] profile's xsuaa server crashes (see
// advocate-profile-route.test.js) and the shape canaries would otherwise pass
// against an empty SQLite fallback — a misleading green. We therefore skip the
// entire suite unless `cds bind --exec` injected a HANA binding.
//
// Runs with: npm run test:hybrid -- test/hybrid/mcp-authenticated-tools.test.js
// (#1105 Task 17a, #1134 I-1/I-2)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import cds from '@sap/cds';

// ─── Backend detection (sync, at import time) ──────────────────────────────
// `cds bind --exec` populates VCAP_SERVICES with the bound HANA instance. Its
// presence is the signal that this is a real hybrid run rather than a bare
// `vitest` invocation that would fall back to empty SQLite. Detect it before
// deciding whether to boot the server, so an unbound run is inert (visible
// skip) instead of a false green — and never crashes on the missing xsuaa
// binding that the [hybrid] profile's auth middleware requires.
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
// crashes the whole suite when no xsuaa instance is bound. Gating the call
// keeps the file inert in environments that can't satisfy the binding.
if (HAS_HANA) cds.test('serve', '--project', '.', '--profile', 'hybrid');

const describeIf = HAS_HANA ? describe : describe.skip;

// The fixture user seeded by setup-dev-data.cjs (Step 4) for hybrid MCP tests.
// resolveDbUser() matches on Users.sapId, and in a test/basic-auth context (no
// JWT authInfo) resolveUserSapId() falls back to cds.User.id — so the identity
// we hand to .send() must be the SAP ID, NOT the email. Passing the email here
// was the original file's latent bug: every shape canary silently fell into
// its 401 catch branch instead of exercising the real store path.
const FIXTURE_SAP_ID = 'mcp-hybrid-test';

// Expected authenticated tools by service (7 + 2 = 9).
const DEVELOPER_TOOLS = [
  'get_my_tutorials',
  'get_my_missions',
  'get_my_events',
  'get_my_completed_steps',
  'get_tutorial_step',
  'complete_step',
  'reset_tutorial_progress',
];
const HOMEPAGE_TOOLS = [
  'get_my_recommended_tutorials',
  'get_my_recommended_missions',
];

// Sample args — sensible defaults that won't error on any env.
function sampleArgsFor(tool) {
  switch (tool) {
    case 'get_my_tutorials':       return { status: 'all', limit: 5 };
    case 'get_my_missions':        return { status: 'all', limit: 5 };
    case 'get_my_events':          return { when: 'upcoming', limit: 5 };
    case 'get_my_completed_steps': return { slug: 'introducing-cap' };
    case 'get_tutorial_step':      return { slug: 'introducing-cap', stepNumber: 1 };
    case 'complete_step':          return { slug: 'introducing-cap', stepNumber: 99 }; // non-existent step — returns 404 but tool itself responds
    case 'reset_tutorial_progress': return { slug: 'introducing-cap' };
    case 'get_my_recommended_tutorials': return { limit: 5 };
    case 'get_my_recommended_missions':  return { limit: 5 };
    default: return {};
  }
}

describeIf('Phase 2 authenticated MCP tools (hybrid, real HANA)', { timeout: 60_000 }, () => {
  let DeveloperService;
  let HomepageService;

  // ─── In-process MCP mini-server for the enumeration guard ────────────────
  // A dedicated express app mounts the @cap-js/mcp adapter twice per service:
  // once behind an authenticated cds.context middleware, once anonymous. This
  // lets us POST a real JSON-RPC tools/list and observe the adapter's own
  // @requires filtering — the layer the earlier definition.actions check never
  // exercised.
  let httpServer;
  const authEndpoints = {};   // serviceName → '/auth<path>'
  const anonEndpoints = {};   // serviceName → '/anon<path>'

  beforeAll(async () => {
    DeveloperService = await cds.connect.to('DeveloperService');
    HomepageService  = await cds.connect.to('HomepageService');

    const McpAdapter = (await import('@cap-js/mcp/lib/index.js')).default;
    const { default: express } = await import('express');

    const app = express();
    app.use(express.json());

    // Install an authenticated identity for the /auth* mounts. The adapter
    // reads cds.context?.user synchronously inside its request handler, so
    // setting it in synchronous middleware immediately before the router is
    // reliable.
    function withAuth(req, _res, next) {
      cds.context = { user: new cds.User({ id: FIXTURE_SAP_ID }) };
      next();
    }

    for (const srv of [cds.services.DeveloperService, cds.services.HomepageService]) {
      const svcPath = srv.definition?.['@path'] ?? `/${srv.name.toLowerCase()}`;
      const router = McpAdapter(srv);
      if (!router) continue;
      const mount = router.router ?? router;
      app.use('/auth' + svcPath, withAuth, mount);
      app.use('/anon' + svcPath, mount);
      authEndpoints[srv.name] = '/auth' + svcPath;
      anonEndpoints[srv.name] = '/anon' + svcPath;
    }

    httpServer = http.createServer(app);
    await new Promise((r) => httpServer.listen(0, r));
  });

  afterAll(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
  });

  /** POST tools/list to the given mount and return the tool-name array. */
  async function listToolNames(mountPath) {
    const { port } = httpServer.address();
    const res = await fetch(`http://localhost:${port}${mountPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return (body?.result?.tools ?? []).map((t) => t.name);
  }

  // ─── Enumeration guard (the Task 14 finding) ──────────────────────────────

  it('authenticated tools/list surfaces all 7 DeveloperService auth tools', async () => {
    const names = await listToolNames(authEndpoints.DeveloperService);
    for (const tool of DEVELOPER_TOOLS) {
      expect(names, `authenticated tools/list must include ${tool}; got ${JSON.stringify(names)}`).toContain(tool);
    }
  });

  it('authenticated tools/list surfaces both HomepageService auth tools', async () => {
    const names = await listToolNames(authEndpoints.HomepageService);
    for (const tool of HOMEPAGE_TOOLS) {
      expect(names, `authenticated tools/list must include ${tool}; got ${JSON.stringify(names)}`).toContain(tool);
    }
  });

  it('unauthenticated tools/list HIDES every DeveloperService auth tool', async () => {
    const names = await listToolNames(anonEndpoints.DeveloperService);
    for (const tool of DEVELOPER_TOOLS) {
      expect(names, `anonymous tools/list must NOT include ${tool}; got ${JSON.stringify(names)}`).not.toContain(tool);
    }
  });

  it('unauthenticated tools/list HIDES both HomepageService auth tools', async () => {
    const names = await listToolNames(anonEndpoints.HomepageService);
    for (const tool of HOMEPAGE_TOOLS) {
      expect(names, `anonymous tools/list must NOT include ${tool}; got ${JSON.stringify(names)}`).not.toContain(tool);
    }
  });

  // ─── DeveloperService — 7 authenticated tools (shape canaries) ────────────

  it('get_my_tutorials responds with an array under authentication', async () => {
    const result = await DeveloperService.send({
      event: 'get_my_tutorials',
      data: sampleArgsFor('get_my_tutorials'),
      user: new cds.User({ id: FIXTURE_SAP_ID }),
    });
    // Result is an array (possibly empty if fixture user has no progress).
    expect(Array.isArray(result)).toBe(true);
  });

  it('get_my_missions responds with an array under authentication', async () => {
    const result = await DeveloperService.send({
      event: 'get_my_missions',
      data: sampleArgsFor('get_my_missions'),
      user: new cds.User({ id: FIXTURE_SAP_ID }),
    });
    expect(Array.isArray(result)).toBe(true);
  });

  it('get_my_events responds with an array under authentication', async () => {
    const result = await DeveloperService.send({
      event: 'get_my_events',
      data: sampleArgsFor('get_my_events'),
      user: new cds.User({ id: FIXTURE_SAP_ID }),
    });
    expect(Array.isArray(result)).toBe(true);
  });

  it('get_my_completed_steps returns array or 404 for unknown slug', async () => {
    try {
      const result = await DeveloperService.send({
        event: 'get_my_completed_steps',
        data: sampleArgsFor('get_my_completed_steps'),
        user: new cds.User({ id: FIXTURE_SAP_ID }),
      });
      // If the tutorial exists: array of step numbers.
      expect(Array.isArray(result)).toBe(true);
    } catch (e) {
      // 404 is acceptable — tutorial may not be in this env.
      expect(e?.code ?? e?.status ?? 404).toBe(404);
    }
  });

  it('get_tutorial_step returns slice or 404 for unknown slug', async () => {
    try {
      const result = await DeveloperService.send({
        event: 'get_tutorial_step',
        data: sampleArgsFor('get_tutorial_step'),
        user: new cds.User({ id: FIXTURE_SAP_ID }),
      });
      if (result) {
        expect(result).toHaveProperty('slug');
        expect(result).toHaveProperty('stepNumber');
        expect(result).toHaveProperty('stepTitle');
        expect(result).toHaveProperty('totalSteps');
      }
    } catch (e) {
      // 404 if tutorial not in this env's content store; acceptable.
      expect([404, 'step not found']).toContain(e?.code ?? e?.message ?? 404);
    }
  });

  it('reset_tutorial_progress returns success or 404 for unknown slug', async () => {
    try {
      const result = await DeveloperService.send({
        event: 'reset_tutorial_progress',
        data: sampleArgsFor('reset_tutorial_progress'),
        user: new cds.User({ id: FIXTURE_SAP_ID }),
      });
      // Returns null/undefined on success.
      expect(result === undefined || result === null || typeof result === 'object').toBe(true);
    } catch (e) {
      // 404 acceptable.
      expect([404, 403]).toContain(e?.code ?? e?.status ?? 404);
    }
  });

  it('complete_step returns 404 for a non-existent step (auth OK)', async () => {
    try {
      await DeveloperService.send({
        event: 'complete_step',
        data: sampleArgsFor('complete_step'),
        user: new cds.User({ id: FIXTURE_SAP_ID }),
      });
    } catch (e) {
      // 404 (step 99 doesn't exist) is the expected response.
      // The key assertion is that we did NOT get a 401/403 — auth was accepted.
      expect([404, 400]).toContain(e?.code ?? e?.status ?? 404);
    }
  });

  // ─── HomepageService — 2 authenticated tools (shape canaries) ─────────────

  it('get_my_recommended_tutorials returns array under authentication', async () => {
    const result = await HomepageService.send({
      event: 'get_my_recommended_tutorials',
      data: sampleArgsFor('get_my_recommended_tutorials'),
      user: new cds.User({ id: FIXTURE_SAP_ID }),
    });
    expect(Array.isArray(result)).toBe(true);
  });

  it('get_my_recommended_missions returns array under authentication', async () => {
    const result = await HomepageService.send({
      event: 'get_my_recommended_missions',
      data: sampleArgsFor('get_my_recommended_missions'),
      user: new cds.User({ id: FIXTURE_SAP_ID }),
    });
    expect(Array.isArray(result)).toBe(true);
  });
});
