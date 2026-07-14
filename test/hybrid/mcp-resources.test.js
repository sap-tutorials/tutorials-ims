// test/hybrid/mcp-resources.test.js
//
// Hybrid: Phase 3 resource endpoints smoke test.
//
// Asserts three things that cannot be proved against an in-memory SQLite DB:
//   1. resources/list on the compose router returns > 0 entries (criterion 3:
//      "resources/list is non-empty against real HANA").
//   2. resources/read for tutorial://<slug> echoes the slug back in JSON.
//   3. resources/read for mission://<slug> echoes the slug back with a
//      tutorials array.
//
// Slug env overrides — use these if the defaults don't exist in your dev channel:
//   MCP_HYBRID_TUTORIAL_SLUG  (default: 'hcp-create-trial-account')
//   MCP_HYBRID_MISSION_SLUG   (default: 'cp-starter-extensions')
//
// Assertion strategy — shape + slug-echo only for the read tests.
// The resource reader is fail-open: a missing slug returns the same JSON
// envelope with slug echoed and totalSteps:0 / tutorials:[]. Asserting the
// shape robustly (slug echoes back, mimeType is application/json, tutorials is
// an array) ensures the test passes for ANY valid or invalid slug rather than
// depending on a specific row existing in this env's HANA instance.
// Only totalSteps > 0 would require the slug to actually exist — that assertion
// is intentionally omitted here and left for env-specific smoke runs (point the
// env var at a known slug in that channel).
//
// Harness pattern — copied from test/hybrid/mcp-authenticated-tools.test.js.
// Uses the same HAS_HANA detection (VCAP_SERVICES with a hana-tagged service)
// and the same cds.test/describeIf guard so the suite is inert when no binding
// is present.
//
// Runs with: npm run test:hybrid -- test/hybrid/mcp-resources.test.js
// (#1106 Task 10)

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

// Slug env overrides — override to target slugs known to exist in your channel.
const KNOWN_TUTORIAL = process.env.MCP_HYBRID_TUTORIAL_SLUG ?? 'hcp-create-trial-account';
const KNOWN_MISSION  = process.env.MCP_HYBRID_MISSION_SLUG  ?? 'cp-starter-extensions';

describeIf('Phase 3 resources — compose router (hybrid, real HANA)', { timeout: 60_000 }, () => {
  // ─── In-process compose-router mini-server ─────────────────────────────────
  // Mount makeComposeRouter on a dedicated express app (not the CDS app's ports)
  // so we can POST real JSON-RPC requests against it and observe the resources
  // layer through the exact same code path that production uses, but without
  // relying on CAP's own HTTP port binding.
  let httpServer;
  let port;

  beforeAll(async () => {
    // Wait for CAP services to be ready.
    const KG = await cds.connect.to('KnowledgeGraphService');
    if (!KG) throw new Error('KnowledgeGraphService did not connect');

    const { default: makeComposeRouter } = await import('../../srv/lib/mcp-compose-router.js');
    const { default: express } = await import('express');

    const app = express();
    app.use(express.json());

    // Mount the compose router for KnowledgeGraphService — this is the service
    // that Phase 3 wires resources onto (RP_MOUNTS in srv/server.js).
    const router = makeComposeRouter(KG);
    app.use('/mcp/graph', router);

    httpServer = http.createServer(app);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  });

  /** POST a JSON-RPC request to the compose mount and return the parsed body. */
  async function mcpRpc(method, params = {}) {
    const res = await fetch(`http://localhost:${port}/mcp/graph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    expect(res.status, `${method} HTTP status`).toBe(200);
    return res.json();
  }

  // ─── Criterion 3: resources/list non-empty against real HANA ───────────────
  // Unit/contract layer can't prove this (in-memory SQLite has no seeded rows).
  // This is the authoritative non-empty assertion.

  it('resources/list returns at least one resource (real HANA has content)', async () => {
    const body = await mcpRpc('resources/list');
    const resources = body?.result?.resources;
    expect(Array.isArray(resources), 'result.resources must be an array').toBe(true);
    expect(
      resources.length,
      `resources/list must return > 0 entries; got ${resources.length}. ` +
      'If this is a fresh env with no published tutorials, run npm run setup-dev-data.'
    ).toBeGreaterThan(0);
    // Each entry must carry the required MCP shape.
    for (const r of resources.slice(0, 3)) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
    }
  });

  // ─── resources/read — tutorial:// shape + slug-echo ────────────────────────
  // Fail-open reader: even a missing slug returns a valid envelope with the slug
  // echoed back. The shape assertions below pass for any slug — present or absent.
  // Slug existence (totalSteps > 0) is intentionally NOT asserted here; use the
  // env var override to point at a known slug when you need that stronger check.

  it('resources/read tutorial://<slug> returns JSON envelope with slug echoed back', async () => {
    const body = await mcpRpc('resources/read', { uri: `tutorial://${KNOWN_TUTORIAL}` });
    const contents = body?.result?.contents;
    expect(Array.isArray(contents), 'result.contents must be an array').toBe(true);
    expect(contents.length, 'contents must have at least one entry').toBeGreaterThan(0);

    const block = contents[0];
    expect(block.mimeType).toBe('application/json');
    expect(block.uri).toBe(`tutorial://${KNOWN_TUTORIAL}`);
    expect(typeof block.text).toBe('string');

    const meta = JSON.parse(block.text);
    expect(meta.slug).toBe(KNOWN_TUTORIAL);
    expect(Array.isArray(meta.steps), 'meta.steps must be an array').toBe(true);
    expect(Array.isArray(meta.tags),  'meta.tags must be an array').toBe(true);
    // totalSteps echoes steps.length — shape check only (not > 0) because the
    // fail-open reader returns 0 for unknown slugs rather than throwing.
    expect(typeof meta.totalSteps).toBe('number');
  });

  // ─── resources/read — mission:// shape + slug-echo ─────────────────────────

  it('resources/read mission://<slug> returns JSON envelope with slug echoed back', async () => {
    const body = await mcpRpc('resources/read', { uri: `mission://${KNOWN_MISSION}` });
    const contents = body?.result?.contents;
    expect(Array.isArray(contents), 'result.contents must be an array').toBe(true);
    expect(contents.length, 'contents must have at least one entry').toBeGreaterThan(0);

    const block = contents[0];
    expect(block.mimeType).toBe('application/json');
    expect(block.uri).toBe(`mission://${KNOWN_MISSION}`);
    expect(typeof block.text).toBe('string');

    const meta = JSON.parse(block.text);
    expect(meta.slug).toBe(KNOWN_MISSION);
    expect(Array.isArray(meta.tutorials), 'meta.tutorials must be an array').toBe(true);
    // If the slug exists in this env, each tutorial entry must be well-shaped.
    for (const t of meta.tutorials) {
      if (t.slug) expect(typeof t.slug).toBe('string');
    }
  });
});
