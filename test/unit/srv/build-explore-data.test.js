// test/unit/srv/build-explore-data.test.js
//
// Unit tests for the features.threeD advertisement and fail-open behaviour
// of exploreDataHandler in srv/lib/build-explore-data.js.
//
// Mocks:
//   - srv/lib/kg-explore-data.js  (buildExplorePayload)
//   - srv/lib/feature-flags/db-flags.js  (isFlagEnabled)
//   - srv/knowledge-graph-service.js  (loadRankMaps)
//   - @sap/cds  (cds.connect.to + cds.log)
//
// Issue #2517.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _payload: undefined,
    _status: 200,
    setHeader: vi.fn(),
    json: vi.fn(function (p) { this._payload = p; return this; }),
    status: vi.fn(function (s) { this._status = s; return this; }),
  };
  return res;
}

function makeReq() {
  return {};
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('exploreDataHandler — features.threeD', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('flag ON → payload.features.threeD === true', async () => {
    const fakePayload = { nodes: [{ id: 'n1' }], edges: [], generatedAt: '2026-01-01T00:00:00Z', droppedBindings: 0 };

    vi.doMock('../../../srv/lib/kg-explore-data.js', () => ({
      buildExplorePayload: vi.fn().mockResolvedValue(fakePayload),
    }));
    vi.doMock('../../../srv/lib/feature-flags/db-flags.js', () => ({
      isFlagEnabled: vi.fn((key) => key === 'KG_EXPLORE_3D_ENABLED'),
    }));
    vi.doMock('../../../srv/knowledge-graph-service.js', () => ({
      loadRankMaps: vi.fn().mockResolvedValue({ conceptRank: new Map(), tutorialRank: new Map(), _normalizeTut: () => 0 }),
    }));
    vi.doMock('@sap/cds', () => ({
      default: {
        log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
        connect: { to: vi.fn().mockResolvedValue({}) },
      },
    }));

    const { exploreDataHandler, _resetExploreDataCache } = await import('../../../srv/lib/build-explore-data.js');
    _resetExploreDataCache();

    const req = makeReq();
    const res = makeRes();
    await exploreDataHandler(req, res);

    expect(res.json).toHaveBeenCalledOnce();
    expect(res._payload).toBeDefined();
    expect(res._payload.features).toBeDefined();
    expect(res._payload.features.threeD).toBe(true);
  });

  it('flag read throws → payload.features.threeD === false (fail-open)', async () => {
    const fakePayload = { nodes: [], edges: [], generatedAt: '2026-01-01T00:00:00Z', droppedBindings: 0 };

    vi.doMock('../../../srv/lib/kg-explore-data.js', () => ({
      buildExplorePayload: vi.fn().mockResolvedValue(fakePayload),
    }));
    vi.doMock('../../../srv/lib/feature-flags/db-flags.js', () => ({
      isFlagEnabled: vi.fn().mockImplementation(() => { throw new Error('db dead'); }),
    }));
    vi.doMock('../../../srv/knowledge-graph-service.js', () => ({
      loadRankMaps: vi.fn().mockResolvedValue({ conceptRank: new Map(), tutorialRank: new Map(), _normalizeTut: () => 0 }),
    }));
    vi.doMock('@sap/cds', () => ({
      default: {
        log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
        connect: { to: vi.fn().mockResolvedValue({}) },
      },
    }));

    const { exploreDataHandler, _resetExploreDataCache } = await import('../../../srv/lib/build-explore-data.js');
    _resetExploreDataCache();

    const req = makeReq();
    const res = makeRes();
    await exploreDataHandler(req, res);

    expect(res.json).toHaveBeenCalledOnce();
    expect(res._payload.features).toBeDefined();
    expect(res._payload.features.threeD).toBe(false);
  });

  it('flag OFF → payload.features.threeD === false', async () => {
    const fakePayload = { nodes: [], edges: [], generatedAt: '2026-01-01T00:00:00Z', droppedBindings: 0 };

    vi.doMock('../../../srv/lib/kg-explore-data.js', () => ({
      buildExplorePayload: vi.fn().mockResolvedValue(fakePayload),
    }));
    vi.doMock('../../../srv/lib/feature-flags/db-flags.js', () => ({
      isFlagEnabled: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('../../../srv/knowledge-graph-service.js', () => ({
      loadRankMaps: vi.fn().mockResolvedValue({ conceptRank: new Map(), tutorialRank: new Map(), _normalizeTut: () => 0 }),
    }));
    vi.doMock('@sap/cds', () => ({
      default: {
        log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
        connect: { to: vi.fn().mockResolvedValue({}) },
      },
    }));

    const { exploreDataHandler, _resetExploreDataCache } = await import('../../../srv/lib/build-explore-data.js');
    _resetExploreDataCache();

    const req = makeReq();
    const res = makeRes();
    await exploreDataHandler(req, res);

    expect(res.json).toHaveBeenCalledOnce();
    expect(res._payload.features).toBeDefined();
    expect(res._payload.features.threeD).toBe(false);
  });
});
