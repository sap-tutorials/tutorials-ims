// test/unit/srv/mission-detail-unavailable.test.js
//
// Asserts that missionDetailHandler returns HTTP 200 with items:[]
// (no onward links) when the mission has temporarilyUnavailable:true.
// A normal mission with completion path items still returns its items.
//
// Harness: cds.test in-memory SQLite (mirrors build-catalog-unavailable.test.js).
// Issue #2864.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

function makeReq(slug, extra = {}) {
  return { params: { slug }, query: {}, user: null, ...extra };
}

function makeRes() {
  const res = {
    _payload: undefined,
    _status: 200,
    _headers: {},
    setHeader: function (k, v) { this._headers[k] = v; return this; },
    json: function (p) { this._payload = p; return this; },
    status: function (s) { this._status = s; return this; },
  };
  return res;
}

describe('missionDetailHandler — temporarilyUnavailable guard (#2864)', () => {
  let handler;
  const DISABLED_SLUG = 'test-disabled-mission-2864';
  const NORMAL_SLUG   = 'test-normal-mission-2864';

  beforeAll(async () => {
    await project;
    const mod = await import('../../../srv/lib/branch/mission-detail.js');
    handler = mod.missionDetailHandler;
    mod.__resetCacheForTest();

    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities(NS);

    // Shared tutorial used by both missions
    const tutId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries([
      { ID: tutId, slug: 'some-tutorial-2864', title: 'Some Tutorial' },
    ]);

    // Disabled mission — seeded WITH a path + item so that items:[] in the
    // assertion genuinely proves the guard suppressed real links (not just an
    // empty-paths coincidence via the paths.length===0 early-return).
    const disabledId     = cds.utils.uuid();
    const disabledPathId = cds.utils.uuid();
    await INSERT.into(Missions).entries([
      {
        ID: disabledId,
        legacyId: 98001,
        title: 'Disabled Mission',
        slug: DISABLED_SLUG,
        published: true,
        temporarilyUnavailable: true,
        unavailableReason: 'maintenance',
      },
    ]);
    await INSERT.into(CompletionPaths).entries([
      { ID: disabledPathId, mission_ID: disabledId, label: 'Default' },
    ]);
    await INSERT.into(CompletionPathItems).entries([
      { ID: cds.utils.uuid(), path_ID: disabledPathId, tutorial_ID: tutId, itemOrder: 1 },
    ]);

    // Normal mission — has one completion path with one tutorial item
    const normalId  = cds.utils.uuid();
    const pathId    = cds.utils.uuid();
    await INSERT.into(Missions).entries([
      {
        ID: normalId,
        legacyId: 98002,
        title: 'Normal Mission',
        slug: NORMAL_SLUG,
        published: true,
        temporarilyUnavailable: false,
      },
    ]);
    await INSERT.into(CompletionPaths).entries([
      { ID: pathId, mission_ID: normalId, label: 'Default' },
    ]);
    await INSERT.into(CompletionPathItems).entries([
      { ID: cds.utils.uuid(), path_ID: pathId, tutorial_ID: tutId, itemOrder: 1 },
    ]);
  });

  it('disabled mission: returns HTTP 200 with empty items and Cache-Control: no-store', async () => {
    const req = makeReq(DISABLED_SLUG);
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._payload).toEqual({ missionSlug: DISABLED_SLUG, items: [] });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('normal mission: returns HTTP 200 with its tutorial items', async () => {
    const req = makeReq(NORMAL_SLUG);
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._payload?.missionSlug).toBe(NORMAL_SLUG);
    expect(Array.isArray(res._payload?.items)).toBe(true);
    expect(res._payload.items.length).toBeGreaterThan(0);
  });
});
