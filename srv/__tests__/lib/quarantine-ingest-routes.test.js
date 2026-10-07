import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { quarantineIngestHandler } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeReq(body = {}, headers = {}) {
  return { body, headers, get(k) { return this.headers[k.toLowerCase()]; } };
}
function makeRes() {
  const res = {
    _status: null, _body: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    setHeader(k, v) { this._headers[k] = v; }
  };
  return res;
}

cds.test('serve', '--project', '.', '--in-memory');

describe('quarantine ingest route', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    const { QuarantineSnapshots, QuarantineEvents, Tutorials } = cds.entities(NS);
    await DELETE.from(QuarantineEvents);
    await DELETE.from(QuarantineSnapshots);
    await DELETE.from(Tutorials);
  });

  it('rejects non-full buildMode with 400', async () => {
    const res = makeRes();
    await quarantineIngestHandler(makeReq({ buildMode: 'slug', events: [] }), res);
    expect(res._status).toBe(400);
  });

  it('rejects non-array events with 400', async () => {
    const res = makeRes();
    await quarantineIngestHandler(makeReq({ buildMode: 'full', events: 'nope' }), res);
    expect(res._status).toBe(400);
  });

  it('inserts a current snapshot + events and flips prior current off', async () => {
    const { QuarantineSnapshots } = cds.entities(NS);

    const res1 = makeRes();
    await quarantineIngestHandler(makeReq({
      runId: 'run-1', workflowUrl: 'https://x/runs/run-1', buildMode: 'full',
      events: [{ slug: 'Foo-Bar', sourceFile: 'foo.md', sourceRepo: 'repo-a', reason: 'empty' }]
    }), res1);
    expect(res1._status).toBe(201);
    expect(res1._body.eventCount).toBe(1);

    const res2 = makeRes();
    await quarantineIngestHandler(makeReq({
      runId: 'run-2', buildMode: 'full',
      events: [{ slug: 'baz', reason: 'bad stepCount' }]
    }), res2);
    expect(res2._status).toBe(201);

    const currents = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(currents.length).toBe(1);
    expect(currents[0].runId).toBe('run-2');
  });

  it('lowercases slugs on insert', async () => {
    const { QuarantineEvents } = cds.entities(NS);
    await quarantineIngestHandler(makeReq({
      runId: 'r', buildMode: 'full',
      events: [{ slug: 'MixedCase-Slug', reason: 'x' }]
    }), makeRes());
    const rows = await SELECT.from(QuarantineEvents);
    expect(rows.map(r => r.slug)).toContain('mixedcase-slug');
  });

  it('is idempotent per runId (repeat replaces, no double-count)', async () => {
    const { QuarantineSnapshots } = cds.entities(NS);
    const body = { runId: 'dup', buildMode: 'full', events: [{ slug: 'a', reason: 'x' }] };
    await quarantineIngestHandler(makeReq(body), makeRes());
    await quarantineIngestHandler(makeReq(body), makeRes());
    const snaps = await SELECT.from(QuarantineSnapshots).where({ runId: 'dup' });
    expect(snaps.length).toBe(1);
  });

  it('empty events on full build writes an empty current snapshot (auto-clear)', async () => {
    const { QuarantineSnapshots } = cds.entities(NS);
    await quarantineIngestHandler(makeReq({ runId: 'clean', buildMode: 'full', events: [] }), makeRes());
    const cur = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(cur.length).toBe(1);
    expect(cur[0].eventCount).toBe(0);
  });

  it('drops events whose slug is a DELETED/INACTIVE tutorial', async () => {
    const { Tutorials, QuarantineEvents } = cds.entities(NS);
    await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'gone-slug', title: 't', status: 'DELETED' },
      { ID: cds.utils.uuid(), slug: 'hidden-slug', title: 't', status: 'INACTIVE' },
      { ID: cds.utils.uuid(), slug: 'live-slug', title: 't', status: 'ACTIVE' },
    ]);
    const res = makeRes();
    await quarantineIngestHandler(makeReq({
      runId: 'filter-run', buildMode: 'full',
      events: [
        { slug: 'Gone-Slug', reason: 'bad stepCount' },
        { slug: 'hidden-slug', reason: 'empty' },
        { slug: 'live-slug', reason: 'unbalanced shortcode' },
      ],
    }), res);
    expect(res._status).toBe(201);
    const rows = await SELECT.from(QuarantineEvents);
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual(['live-slug']);
  });
});
