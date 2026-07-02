// test/unit/srv/kg-path-v2-handler-flag.test.js
// Handler-level flag-behavior tests. Uses cds.test('serve') to spin up an
// in-memory SQLite instance and exercise the pathBetween handler via
// OData.
//
// TEST-INJECTION HOOKS (adaptation from plan): cds.test('serve') pre-resolves
// srv/knowledge-graph-service.js via cds.utils._import (dynamic file:// URL
// on Windows) which BYPASSES vitest's vi.mock ESM interceptor. Same
// documented limitation as in test/unit/srv/admin-service-explainer-actions.test.js.
// Workaround: srv/knowledge-graph-service.js checks
// `globalThis.__KG_PATH_V2_TEST_IMPL__` and `globalThis.__KG_QUERY_TEST_IMPL__`
// and prefers those over the module imports. Production never sets these.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import cds from '@sap/cds';

// Enable the KG service surface (bypasses the this.before('*') 503 gate).
// Must be set BEFORE cds.test() boots so resolveKnowledgeGraphSettings
// picks it up on the first request. The setting is DB→env→default; with
// no DB row (in-memory boot has no seeded ChatSettings), env wins.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

// cds.test spins up the service. Point at the project root; the KG service
// registers automatically via `cds.service.impl` in srv/knowledge-graph-service.js.
const { GET } = cds.test('serve', '--project', '.', '--in-memory');

// Test-injection hooks — see block comment at top.
const kgPathV2Mock = vi.fn();
const kgQueryMock = vi.fn();
globalThis.__KG_PATH_V2_TEST_IMPL__ = (...args) => kgPathV2Mock(...args);
globalThis.__KG_QUERY_TEST_IMPL__ = (...args) => kgQueryMock(...args);

// Capture cds.log warns for the fail-open assertion.
// Note: cds.log('kg') is memoized — swap its `warn` method after cds is
// initialized (grabbing the same memoized logger the handler will use).
const warnCalls = [];
const kgLog = cds.log('kg');
const originalWarn = kgLog.warn.bind(kgLog);
kgLog.warn = (...args) => { warnCalls.push({ topic: 'kg', args }); };

beforeEach(() => {
  kgPathV2Mock.mockReset();
  kgQueryMock.mockReset();
  warnCalls.length = 0;
});

afterEach(() => {
  delete process.env.KG_PATH_V2_ENABLED;
});

afterAll(() => {
  delete globalThis.__KG_PATH_V2_TEST_IMPL__;
  delete globalThis.__KG_QUERY_TEST_IMPL__;
  kgLog.warn = originalWarn;
});

const CALL = `/graph/pathBetween(fromSlug='a',toSlug='b')`;

describe('pathBetween handler — flag off', () => {
  it('v2 wrapper is never called; v1 (kgQuery) runs', async () => {
    delete process.env.KG_PATH_V2_ENABLED;
    // v1 SPARQL result — an empty PATH_BETWEEN JSON body.
    kgQueryMock.mockResolvedValue({
      response: JSON.stringify({ results: { bindings: [] } }),
    });
    const { data } = await GET(CALL);
    expect(kgPathV2Mock).not.toHaveBeenCalled();
    expect(kgQueryMock).toHaveBeenCalledOnce();
    expect(data.value).toEqual([]);
  });
});

describe('pathBetween handler — flag on', () => {
  beforeEach(() => { process.env.KG_PATH_V2_ENABLED = 'true'; });

  it('v2 returns rows → response is v2-mapped, v1 not called', async () => {
    kgPathV2Mock.mockResolvedValue([
      { pathRank: 1, hopCount: 2, vertices: ['tutorial:a', 'concept:c1', 'tutorial:b'] },
    ]);
    const { data } = await GET(CALL);
    expect(kgPathV2Mock).toHaveBeenCalledOnce();
    expect(kgQueryMock).not.toHaveBeenCalled();
    expect(data.value).toEqual(['a', 'b']);
  });

  it('v2 returns [] → falls through to v1 (kgQuery called)', async () => {
    kgPathV2Mock.mockResolvedValue([]);
    kgQueryMock.mockResolvedValue({
      response: JSON.stringify({ results: { bindings: [] } }),
    });
    await GET(CALL);
    expect(kgPathV2Mock).toHaveBeenCalledOnce();
    expect(kgQueryMock).toHaveBeenCalledOnce();
    expect(warnCalls).toHaveLength(0);
  });

  it('v2 throws → falls through to v1 AND logs kg_path_v2_failed', async () => {
    const err = new Error('boom'); err.code = 42;
    kgPathV2Mock.mockRejectedValue(err);
    kgQueryMock.mockResolvedValue({
      response: JSON.stringify({ results: { bindings: [] } }),
    });
    await GET(CALL);
    expect(kgQueryMock).toHaveBeenCalledOnce();
    expect(warnCalls.some(w =>
      w.args[0] === 'kg_path_v2_failed' &&
      w.args[1]?.code === 42 &&
      w.args[1]?.fromSlug === 'a'
    )).toBe(true);
  });
});
