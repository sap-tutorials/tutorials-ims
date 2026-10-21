// test/unit/srv/build-catalog-unavailable.test.js
//
// Asserts that a Mission with temporarilyUnavailable:true and
// unavailableReason:'maintenance' surfaces those fields in the
// /build/catalog payload emitted by buildCatalogHandler.
//
// Harness: cds.test in-memory SQLite (same as build-topics-gallery.test.js).
// Issue #2864.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

function makeRes() {
  const res = {
    _payload: undefined,
    _status: 200,
    _headers: {},
    set: function (k, v) { this._headers[k] = v; return this; },
    json: function (p) { this._payload = p; return this; },
    status: function (s) { this._status = s; return this; },
  };
  return res;
}

describe('buildCatalogHandler — temporarilyUnavailable fields (#2864)', () => {
  let handler;

  beforeAll(async () => {
    await project;
    const mod = await import('../../../srv/lib/build-catalog.js');
    handler = mod.buildCatalogHandler;

    const { Missions } = cds.entities(NS);
    await INSERT.into(Missions).entries([
      {
        ID: cds.utils.uuid(),
        legacyId: 88001,
        title: 'Test Mission Unavailable',
        slug: 'test-mission-unavailable',
        published: true,
        temporarilyUnavailable: true,
        unavailableReason: 'maintenance',
      },
    ]);
  });

  it('emits temporarilyUnavailable:true and unavailableReason on the catalog mission object', async () => {
    const req = {};
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._payload).toBeDefined();
    const missions = res._payload.missions;
    expect(Array.isArray(missions)).toBe(true);

    const m = missions.find((x) => x.slug === 'test-mission-unavailable');
    expect(m).toBeDefined();
    expect(m.temporarilyUnavailable).toBe(true);
    expect(m.unavailableReason).toBe('maintenance');
  });
});
